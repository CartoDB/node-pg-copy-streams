'use strict';

var assert = require('assert')
var gonna = require('gonna')

var _ = require('lodash')
var async = require('async')
var concat = require('concat-stream')
var pg = require('pg')

var copy = require('../').to
var code = require('../message-formats')

var client = function() {
  var client = new pg.Client()
  client.connect()
  return client
}

var testConstruction = function() {
  var txt = 'COPY (SELECT * FROM generate_series(0, 10)) TO STDOUT'
  var stream = copy(txt, {highWaterMark: 10})
  assert.equal(stream._readableState.highWaterMark, 10, 'Client should have been set with a correct highWaterMark.')
}
testConstruction()

var testComparators = function() {
  var copy1 = copy();
  copy1.pipe(concat(function(buf) {
    assert(copy1._gotCopyOutResponse, 'should have received CopyOutResponse')
    assert(!copy1._remainder, 'Message with no additional data (len=Int4Len+0) should not leave a remainder')
  }))
  copy1.end(new Buffer.from([code.CopyOutResponse, 0x00, 0x00, 0x00, 0x04])); 


}
testComparators();

var testRange = function(top) {
  var fromClient = client()
  var txt = 'COPY (SELECT * from generate_series(0, ' + (top - 1) + ')) TO STDOUT'
  var res;


  var stream = fromClient.query(copy(txt))
  var done = gonna('finish piping out', 1000, function() {
    fromClient.end()
  })

  stream.pipe(concat(function(buf) {
    res = buf.toString('utf8')
  }))

  stream.on('end', function() {
    var expected = _.range(0, top).join('\n') + '\n'
    assert.equal(res, expected)
    assert.equal(stream.rowCount, top, 'should have rowCount ' + top + ' but got ' + stream.rowCount)
    done()
  });
}
testRange(10000)

var testInternalPostgresError = function() {
  var cancelClient = client()
  var queryClient = client()

  var runStream = function(callback) {
    var txt = "COPY (SELECT pg_sleep(10)) TO STDOUT"
    var stream = queryClient.query(copy(txt))
    stream.on('data', function(data) {
      // Just throw away the data.
    })
    stream.on('error', callback)

    setTimeout(function() {
      var cancelQuery = "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query ~ 'pg_sleep' AND NOT query ~ 'pg_cancel_backend'"
      cancelClient.query(cancelQuery, function() { cancelClient.end() })
    }, 50)
  }

  runStream(function(err) {
    assert.notEqual(err, null)
    var expectedMessage = 'canceling statement due to user request'
    assert.notEqual(err.toString().indexOf(expectedMessage), -1, 'Error message should mention reason for query failure.')
    queryClient.end()
  })
}
testInternalPostgresError()

var testNoticeResponse = function() {
  // we use a special trick to generate a warning
  // on the copy stream.
  var queryClient = client()
  var set = '';
  set += 'SET SESSION client_min_messages = WARNING;'
  set += 'SET SESSION standard_conforming_strings = off;'
  set += 'SET SESSION escape_string_warning = on;'
  queryClient.query(set, function(err, res) {
    assert.equal(err, null, 'testNoticeResponse - could not SET parameters')
    var runStream = function(callback) {
      var txt = "COPY (SELECT '\\\n') TO STDOUT"
      var stream = queryClient.query(copy(txt))
      stream.on('data', function(data) {
      })
      stream.on('error', callback)
     
      // make sure stream is pulled from 
      stream.pipe(concat(callback.bind(null,null)))
    }

    runStream(function(err) {
      assert.equal(err, null, err)
      queryClient.end()
    })

  })
}
testNoticeResponse();

var warnAndReturnOne = `
CREATE OR REPLACE FUNCTION pg_temp.test_warn_return_one()
RETURNS INTEGER
AS $$
BEGIN
  RAISE WARNING 'hey, this is returning one';
  RETURN 1;
END;
$$ LANGUAGE plpgsql`;

var testInterspersedMessageDoesNotBreakCopyFlow = function() {
  var toClient = client();
  toClient.query(warnAndReturnOne, (err, res) => {
    var q = "COPY (SELECT * FROM pg_temp.test_warn_return_one()) TO STDOUT WITH (FORMAT 'csv', HEADER true)";
    var stream = toClient.query(copy(q));
    var done = gonna('got expected COPY TO payload', 1000, function() {
      toClient.end();
    });

    stream.pipe(concat(function(buf) {
      res = buf.toString('utf8')
    }));

    stream.on('end', function() {
      var expected = "test_warn_return_one\n1\n";
      assert.equal(res, expected);
      // note the header counts as a row
      assert.equal(stream.rowCount, 2, 'should have rowCount = 2 but got ' + stream.rowCount);
      done();
    });
  });
};
testInterspersedMessageDoesNotBreakCopyFlow();

var testClientReuse = function() {
  var c = client();
  var limit = 100000;
  var countMax = 10;
  var countA = countMax;
  var countB = 0;
  var runStream = function(num, callback) {
    var sql = "COPY (SELECT * FROM generate_series(0,"+limit+")) TO STDOUT"
    var stream = c.query(copy(sql))
    stream.on('error', callback)
    stream.pipe(concat(function(buf) {
      var res = buf.toString('utf8');
      var exp = _.range(0, limit+1).join('\n') + '\n'
      assert.equal(res, exp, 'clientReuse: sent & received buffer should be equal')
      countB++;
      callback();
    }))
  }
  
  var rs = function(err) {
    assert.equal(err, null, err)
    countA--;
    if (countA) {
      runStream(countB, rs)
    } else {
      assert.equal(countB, countMax, 'clientReuse: there should be countMax queries on the same client')
      c.end()
    }
  };

  runStream(countB, rs);

}
testClientReuse();

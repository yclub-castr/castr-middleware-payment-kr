// app/db.js

'use strict';

const logger = require('./utils').logger();
const MongoClient = require('mongodb');

let _db;

module.exports = {
    "connect": function (callback) {
        MongoClient.connect('mongodb://' + process.env.DB_USER + ':' + process.env.DB_PW + '@ds123400.mlab.com:23400/' + process.env.DB_HOST)
            .then(function (db) {
                _db = db;
                logger.debug('DB connection successful.')
                return callback(null);
            })
            .catch(function (err) {
                logger.debug('DB connection failure.')
                return callback(err);
            })
    },

    "getDB": function () {
        return _db;
    }
}
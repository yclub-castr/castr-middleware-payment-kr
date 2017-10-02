
const MongoClient = require('mongodb');
const config = require('./config');

const url = config.db.url;

module.exports = {
    connect: function (callback) {
        MongoClient.connect(url, (err, db) => {
            _db = db;
            return callback(err);
        });
    },

    getDB: function () {
        return _db;
    }
}
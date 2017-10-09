
const MongoClient = require('mongodb');

module.exports = {
    connect: function (callback) {
        MongoClient.connect('mongodb://' + process.env.DB_USER + ':' + process.env.DB_PW + '@ds123400.mlab.com:23400/' + process.env.DB_HOST)
            .then(function (db) {
                _db = db;
                return callback(null);
            })
            .catch(function (err) {
                return callback(err);
            })
    },

    getDB: function () {
        return _db;
    }
}
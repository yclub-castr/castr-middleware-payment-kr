const express = require('express');
const mongoDB = require('../db');
const iamport = require('./op.service');

const router = express.Router();

router.route('/')

    .get(function (req, res) {
        mongoDB.getDB().collection('op-callback-test').updateOne(
            { 'key1': 'value1' },
            {
                'key1': 'value1',
                'key2': 'value2'
            },
            { 'upsert': true },
            function (err, result) {
                res.send(result);
            }
        );
    });

module.exports = router
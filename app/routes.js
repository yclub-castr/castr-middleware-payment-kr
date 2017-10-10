// app/routes.js

'use strict';

const express = require('express');
const iamport_router = require('./iamport/iamport.route')
const op_router = require('./open-platform/op.route')

const router = express.Router();

router.get('/', function (req, res) {
    res.send('It\'s alive!!!');
});

router.use('/payment', iamport_router);
router.use('/open-platform', op_router);

module.exports = router;

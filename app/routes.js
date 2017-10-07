// app/routes.js

const express = require('express');

const iamport_router = require('./iamport/iamport.route')
const op_router = require('./open-platform/op.route')

const router = express.Router();

router.get('/', function (req, res) {
    res.send('It\'s alive!!!');
});

if(process.env.LOCALE === 'ko_KR'){
    router.use('/payment', iamport_router);
    router.use('/open-platform', op_router);
}

router.route('/echo')
    .get(function (req, res) {
        const keys = Object.keys(req.query);
        for (let i = 0; i < keys.length; i++) {
            console.log(keys[i] + ': ' + req.query[keys[i]]);
        };
        res.send(req.query);
    })
    .post(function (req, res) {
        const keys = Object.keys(req.body);
        for (let i = 0; i < keys.length; i++) {
            console.log(keys[i] + ': ' + req.body[keys[i]]);
        };
        res.send(req.body);
    });

router.route('/echo/:path_var')
    .get(function (req, res) {
        const path_var = req.params.path_var;
        console.log('path_var: ' + path_var);
        res.send(path_var);
    })

module.exports = router;

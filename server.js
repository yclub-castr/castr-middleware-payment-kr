// server.js

require('dotenv').config();

const express = require('express');
const mongoDB = require('./app/db')
const bodyParser = require('body-parser');
const routes = require('./app/routes');
const iamportService = require('./app/iamport/iamport.service');
const logger = require('tracer').console({
    format: "[{{timestamp}}] <{{title}}> {{message}} - ({{file}}:{{line}})",
    dateformat: "mmm. d | HH:MM:ss.L"
});

const app = express()
const port = process.env.PORT;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

mongoDB.connect(function (err) {
    app.use('/', routes);

    // Schdule payment-schedule check at next 6AM
    iamportService._checkScheduleAt6AM();

    app.listen(port, () => {
        logger.debug('we are live on ' + port);
    });
});
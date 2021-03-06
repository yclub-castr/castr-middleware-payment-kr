// app/utils.js

'use strict';

const tracer = require('tracer');
const moment = require('moment-timezone');
const nodemailer = require('nodemailer');

// Tracer - logger
const logger = tracer.console({
    format: '[{{timestamp}}] <{{title}}> {{message}} - ({{file}}:{{line}})',
    dateformat: 'mmm. d | HH:MM:ss.L',
});

// Moment - date wrapper
moment.locale('kr', {
    months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
    // "monthsShort": RESERVED FOR ENGLISH ABBREVIATED MONTHS
    weekdays: ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'],
    // "weekdaysShort": RESERVED FOR ENGLISH ABBREVIATED WEEKDAYS
    weekdaysMin: ['월', '화', '수', '목', '금', '토', '일'],
    longDateFormat: {
        LT: 'A h:mm',
        LTS: 'A h:mm:ss',
        L: 'YYYY/MM/DD',
        LL: 'YYYY년 M월 D일',
        LLL: 'YYYY년 M월 D일 LT',
        LLLL: 'YYYY년 M월 D일 dddd LT',
    },
    meridiem(hour, minute, isLowercase) {
        if (hour < 12) {
            return '오전';
        }
        return '오후';
    },
});
moment.locale('en');

// Nodemailer - email transporter
const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        type: 'OAuth2',
        user: process.env.FROM_EMAIL_ID,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
        accessToken: process.env.GMAIL_ACCESS_TOKEN,
    },
});

// Winston PaperTrail - logger
const winston = require('winston');
require('winston-papertrail').Papertrail; // eslint-disable-line no-unused-expressions

const host = 'logs6.papertrailapp.com';
const port = 42065;

const nodeWinstonPapertrail = new winston.transports.Papertrail({
    host: host,
    port: port,
    program: 'API',
    colorize: true,
    logFormat: function (level, message) {
        return message;
    },
});

const nodeLogger = new winston.Logger({
    transports: [nodeWinstonPapertrail],
});

module.exports = {
    logger() {
        if (process.env.ENVIRONMENT === 'AWS-DEV') {
            return nodeLogger;
        } else if (process.env.ENVIRONMENT === 'DEV') {
            return logger;
        }
        return nodeLogger;
    },
    moment() {
        return moment;
    },
    nodemailer() {
        return transporter;
    },
};

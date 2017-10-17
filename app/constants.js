const timezone = {
    kr: 'ASIA/SEOUL',
    utc: 'UTC',
};
const payment_type = {
    initial: 'INITIAL',
    scheduled: 'SCHEDULED',
    refund: 'REFUND',
    mc_purchase: 'PURCHASE',
    mc_redeem: 'REDEEM',
};
const billing_plan_type = {
    '4_WEEK': 4,
    '26_WEEK': 26,
    '52_WEEK': 52,
};
const status_type = {
    paid: 'PAID',
    cancelled: 'REFUNDED',
    failed: 'FAILED',
    scheduled: 'SCHEDULED',
    unscheduled: 'CANCELLED',
    paused: 'PAUSED',
    redeemed: 'REDEEMED',
};
const full_day = 24 * 60 * 60 * 1000;
const week = full_day * 7;
const refund_fee_perc = 0.2;
const redeem_fee = 100;
const purchase_fee = 250;

module.exports = {
    timezone: timezone,
    payment_type: payment_type,
    billing_plan_type: billing_plan_type,
    status_type: status_type,
    full_day: full_day,
    week: week,
    refund_fee_perc: refund_fee_perc,
    redeem_fee: redeem_fee,
    purchase_fee: purchase_fee,
}
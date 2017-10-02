# castr-middleware-payment-kr

## Debug 
`npm run-script dev`

## Important
The official I'mport node.js SDK does not currently provide some functions and needs some tweak before they accept my pull request. Please make these changes in the installed **iamport** package files.

1. iamport/lib/resources/Subscribe_customer.js
  
    Add this block to the exported object
   ```
    getPayments: iamportMethod({
        method: 'GET',
        command: 'customers',
        urlParam: 'customer_uid',
        command2: 'payments'
    })
   ```

2. iamport/lib/iamportMethod.js

    Add this block
    ```
    if(spec.command2){
        apiParams.push(spec.command2);
    }
    ```
    after this existing block
    ```
    if(spec.urlParam) {
       if( hasOwn.call(param, spec.urlParam) ) {
         apiParams.push( param[spec.urlParam] );
         param = _.omit(param, spec.urlParam);
       } else {
         return new Promise(function(resolve, reject) {
           reject(new Error('Param missing: ' + spec.urlParam));
         });
        }
      }
    ```
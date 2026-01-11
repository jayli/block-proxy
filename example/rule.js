module.exports = {
  AAA: [
    {
      'type': 'beforeSendResponse',
      'host': '163.com',
      'regexp': "/123/v1/(browse|next)",
      'callback': async function(url, request, response) {
        return {
          response
        }
      } // -- callback
    },
    {
      'type': 'beforeSendResponse',
      'host': '163.com',
      'regexp': "/456",
      'callback': async function(url, request, response) {
        return {
          response
        }
      } // -- callback
    }
  ],
  BBB: [
    {
      type: "beforeSendRequest",
      host: "163.com",
      regexp: "/hello",
      callback: async function(url, request, response) {
        return {
          response : {
            statusCode: 200,
            body: 'hello world'
          }
        }
      }
    }
  ]
};

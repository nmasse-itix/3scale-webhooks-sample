// Dependencies
var express = require("express");
var _ = require("underscore");
var util = require('util');
var xmlparser = require('express-xml-bodyparser');
var req = require('request');

// ExpressJS Setup
var app = express();
var router = express.Router();
var port = 8080;

var my_url = "/webhook";
var shared_secret = process.env.SHARED_SECRET;
if (shared_secret == null || shared_secret == "") {
  console.log("WARNING: Authentication is DISABLED !");
  console.log("WARNING: Please add an environment variable named 'SHARED_SECRET' to enable authentication");
} else {
  my_url += util.format("?shared_secret=%s", encodeURIComponent(shared_secret));
}

var failed = false;
var sso = {};
_.each(['SSO_REALM', 'SSO_HOSTNAME', 'SSO_CLIENT_ID', 'SSO_SERVICE_USERNAME', 'SSO_SERVICE_PASSWORD'], (item) => {
  if ((item in process.env) && (process.env[item] != null)) {
    sso[item] = process.env[item];
  } else {
    console.log("ERROR: Environment variable '%s' is missing or empty.", item);
    failed = true;
  }
});

if (failed) {
  console.log("Exiting !")
  process.exit(1)
}

var webhooks_handlers = {
  application: handle_application
};

// Log every request
router.use(function (req,res,next) {
  next();
  console.log("%s %s => %d", req.method, req.originalUrl, res.statusCode);
});

// Any GET on / ends up with a nice documentation as JSON
router.get("/",function(req,res){
  var response = {
    name: "3scale Sample Webhook",
    description: "A sample project that handles 3scale webhooks",
    endpoints: [
                 {
                   "url": "/webhook",
                   "verbs": [ "GET", "POST" ]
                 }
               ],
    documentation: {
      "GitHub": "TODO"
    }
  };
  success(res, 200, response);
});

// Ping Webhook
router.get("/webhook",function(req,res){
  var response = { pong: "webhook" };
  success(res, 200, response);
});

// Handle Webhook
router.post("/webhook",function(req,res){
  var payload = req.body;
  if (payload == null) {
    return error(res, 400, "No body sent !");
  }

  var event = payload.event;
  if (event == null) {
    return error(res, 400, "No event found in payload !");
  }

  var action = event.action;
  var type = event.type;
  var obj = event.object[type];
  if (obj == null) {
    return error(res, 400, "No object found in payload !");
  }

  if (type in webhooks_handlers) {
    return webhooks_handlers[type](res, action, type, obj);
  } else {
    error(res, 412, util.format("No handlers to handle '%s'", type));
  }
});

function handle_application(res, action, type, app) {
  console.log("action = %s, type = %s", action, type);
  console.log(obj);

  var client = {
    clientId: app.application_id,
    clientAuthenticatorType: "client-secret",
    secret: app.keys.key,
    redirectUris: [ app.redirect_url ],
    publicClient: false,
    name: app.name,
    description: app.description
  };

  authenticate_to_sso(res, (access_token) => {
    get_sso_client(res, client.client_id, access_token, (sso_client) => {
      if (sso_client == null) {
        create_sso_client(res, access_token, client, (response) => {
          success(res, 200, "TODO");
        });
      } else {
        update_sso_client(res, access_token, client, sso_client.id, (response) => {
          success(res, 200, "TODO");
        });
      }
    });
  });
}

//
// Please find below the plumbing code
//

// Register the XML Parser for POST requests
app.use(xmlparser({explicitArray: false}));

// Register the router
app.use("/",router);

// 404 Handler (Not Found)
app.use("*",function(req,res){
  error(res, 404, "Not found");
});

// Start the HTTP Server
app.listen(port,function(){
  console.log("Webhook server listening at port %d", port);
  console.log("Please use url 'https://<your_openshift_route>%s' in the Webhooks configuration of 3scale.", my_url);
});

function error(res, code, message) {
  var response = {
    status: code,
    message: message
  };
  return res.status(code)
            .type("application/json")
            .send(JSON.stringify(response));
}

function success(res, code, response) {
  return res.status(code)
            .type("application/json")
            .send(JSON.stringify(response));
}

function get_sso_client(res, client_id, access_token, next) {
  req.get(util.format("https://%s/auth/admin/realms/%s/clients", sso.SSO_HOSTNAME, sso.SSO_REALM),
  {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    qs: {
      clientId: client_id
    }
  }).on('response', (response) => {
      var json_response = JSON.parse(response.body);
      var sso_client = null;
      if (json_response.length > 0) {
        sso_client = json_response[0];
      }
      next(sso_client);
  }).on('error', (err) => {
    return error(res, 500, err);
  });
}

function create_sso_client(res, access_token, client, next) {
  req.post(util.format("https://%s/auth/admin/realms/%s/clients", sso.SSO_HOSTNAME, sso.SSO_REALM), {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    json: client
  }).on('response', (response) => {
      var client = JSON.parse(response.body);
      next(client);
  }).on('error', (err) => {
    return error(res, 500, err);
  });
}

function update_sso_client(res, access_token, client, id, next) {
  req.put(util.format("https://%s/auth/admin/realms/%s/clients/%d", sso.SSO_HOSTNAME, sso.SSO_REALM, id), {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    json: client
  }).on('response', (response) => {
      var client = JSON.parse(response.body);
      next(client);
  }).on('error', (err) => {
    return error(res, 500, err);
  });
}

function authenticate_to_sso(res, next) {
  req.post(util.format("https://%s/auth/realms/%s/protocol/openid-connect/token", sso.SSO_HOSTNAME, sso.SSO_REALM), {
    form: {
      grant_type: "password",
      client_id: sso.SSO_CLIENT_ID,
      username: sso.SSO_SERVICE_USERNAME,
      password: sso.SSO_SERVICE_PASSWORD
    },
  }).on('response', (response) => {
      var json_response = JSON.parse(response.body);
      next(json_response.access_token);
  }).on('error', (err) => {
    return error(res, 500, err);
  });
}

// Dependencies
var express = require("express");
var _ = require("underscore");
var util = require('util');
var xmlparser = require('express-xml-bodyparser');
var req = require('request').defaults({
  strictSSL: false
});

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
      "GitHub": "https://github.com/nmasse-itix/3scale-webhooks-sample"
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
  console.log(app);

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
    get_sso_client(res, client.clientId, access_token, (sso_client) => {
      if (sso_client == null) {
        console.log("Could not find a client, creating it...");
        create_sso_client(res, access_token, client, (response) => {
          console.log("OK, client created !")
          success(res, 200, "TODO");
        });
      } else {
        console.log("Found an existing client with id = %s", sso_client.id);
        update_sso_client(res, access_token, client, sso_client.id, (response) => {
          console.log("OK, client updated !")
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
  req.get({
    url: util.format("https://%s/auth/admin/realms/%s/clients", sso.SSO_HOSTNAME, sso.SSO_REALM),
    headers: {
      "Authorization": "Bearer " + access_token
    },
    qs: {
      clientId: client_id
    }
  }, (err, response, body) => {
    if (err) {
      return error(res, 500, err);
    }
    console.log("Got a %d response from SSO", response.statusCode);

    if (response.statusCode == 200) {
      try {
        var json_response = JSON.parse(body);
        var sso_client = null;
        console.log("Found %d clients", json_response.length);
        if (json_response.length == 1) {
          sso_client = json_response[0];
          console.log("Picking the first one : '%s', with id = %s", sso_client.clientId, sso_client.id);
        } else if (json_response.length > 1) {
          console.log("Too many matching clients (%d). Refusing to do anything.", json_response.length);
          return error(res, 500, util.format("Too many matching clients (%d). Refusing to do anything.", json_response.length));
        }
        next(sso_client);
      } catch (err) {
        return error(res, 500, err);
      }
    } else {
      return error(res, 500, util.format("Got a %d response from SSO while trying to check if client exists", response.statusCode));
    }
  });
}

function create_sso_client(res, access_token, client, next) {
  req.post(util.format("https://%s/auth/admin/realms/%s/clients", sso.SSO_HOSTNAME, sso.SSO_REALM), {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    json: client
  }, (err, response, body) => {
    if (err) {
      return error(res, 500, err);
    }
    console.log("Got a %d response from SSO", response.statusCode);
    if (response.statusCode == 201) {
      try {
        var client = JSON.parse(body);
        next(client);
      } catch (err) {
        return error(res, 500, err);
      }
    } else {
      return error(res, 500, util.format("Got a %d response from SSO while creating client", response.statusCode));
    }
  });
}

function update_sso_client(res, access_token, client, id, next) {
  req.put(util.format("https://%s/auth/admin/realms/%s/clients/%s", sso.SSO_HOSTNAME, sso.SSO_REALM, id), {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    json: client
  }, (err, response, body) => {
    if (err) {
      return error(res, 500, err);
    }
    console.log("Got a %d response from SSO", response.statusCode);
    if (response.statusCode == 204) {
      try {
        next();
      } catch (err) {
        return error(res, 500, err);
      }
    } else {
      return error(res, 500, util.format("Got a %d response from SSO while updating client", response.statusCode));
    }
  });
}

function authenticate_to_sso(res, next) {
  console.log("Authenticating to SSO (realm = '%s') using the ROPC OAuth flow with %s/%s", sso.SSO_REALM, sso.SSO_SERVICE_USERNAME, sso.SSO_SERVICE_PASSWORD);
  req.post(util.format("https://%s/auth/realms/%s/protocol/openid-connect/token", sso.SSO_HOSTNAME, sso.SSO_REALM), {
    form: {
      grant_type: "password",
      client_id: sso.SSO_CLIENT_ID,
      username: sso.SSO_SERVICE_USERNAME,
      password: sso.SSO_SERVICE_PASSWORD
    }
  }, (err, response, body) => {
      if (err) {
        return error(res, 500, err);
      }
      console.log("Got a %d response from SSO", response.statusCode);
      if (response.statusCode == 200) {
        try {
          var json_response = JSON.parse(body);
          console.log("Got an access token from SSO: %s", json_response.access_token);
          next(json_response.access_token);
        } catch (err) {
          return error(res, 500, err);
        }
      } else {
        return error(res, 500, util.format("Got a %d response from SSO while authenticating", response.statusCode));
      }
  });
}

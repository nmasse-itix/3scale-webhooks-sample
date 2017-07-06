var _ = require("underscore");
var util = require('util');
var req = require('request').defaults({
  strictSSL: false
});

var config = {};

function sso_init() {
  var failed = false;
  _.each(['SSO_REALM', 'SSO_HOSTNAME', 'SSO_CLIENT_ID', 'SSO_SERVICE_USERNAME', 'SSO_SERVICE_PASSWORD'], (item) => {
    if ((item in process.env) && (process.env[item] != null)) {
      config[item] = process.env[item];
    } else {
      console.log("ERROR: Environment variable '%s' is missing or empty.", item);
      failed = true;
    }
  });

  if (failed) {
    throw new Error("Missing configuration");
  }
}

function sso_register(types) {
  return [ "application" ];
}

function sso_handle(action, type, app, next) {
  if (type == "application") {
    handle_application(action, type, app, next);
  }
}

exports.handle = sso_handle;
exports.register = sso_register;
exports.init = sso_init;


function handle_application(action, type, app, next) {
  var client = {
    clientId: app.application_id,
    clientAuthenticatorType: "client-secret",
    secret: app.keys.key,
    redirectUris: [ app.redirect_url ],
    publicClient: false,
    name: app.name,
    description: app.description
  };

  authenticate_to_sso(next, (access_token) => {
    get_sso_client(client.clientId, access_token, next, (sso_client) => {
      if (sso_client == null) {
        console.log("Could not find a client, creating it...");
        create_sso_client(access_token, client, (response) => {
          console.log("OK, client created !")
          next('SUCCESS');
        });
      } else {
        console.log("Found an existing client with id = %s", sso_client.id);
        update_sso_client(access_token, client, sso_client.id, next, (response) => {
          console.log("OK, client updated !");
          next('SUCCESS');
        });
      }
    });
  });
}


function get_sso_client(client_id, access_token, error, next) {
  req.get({
    url: util.format("https://%s/auth/admin/realms/%s/clients", config.SSO_HOSTNAME, config.SSO_REALM),
    headers: {
      "Authorization": "Bearer " + access_token
    },
    qs: {
      clientId: client_id
    }
  }, (err, response, body) => {
    if (err) {
      return error(err);
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
          return error(util.format("Too many matching clients (%d). Refusing to do anything.", json_response.length));
        }
        next(sso_client);
      } catch (err) {
        return error(err);
      }
    } else {
      return error(util.format("Got a %d response from SSO while trying to check if client exists", response.statusCode));
    }
  });
}

function create_sso_client(access_token, client, error, next) {
  req.post(util.format("https://%s/auth/admin/realms/%s/clients", config.SSO_HOSTNAME, config.SSO_REALM), {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    json: client
  }, (err, response, body) => {
    if (err) {
      return error(err);
    }
    console.log("Got a %d response from SSO", response.statusCode);
    if (response.statusCode == 201) {
      try {
        var client = JSON.parse(body);
        next(client);
      } catch (err) {
        return error(err);
      }
    } else {
      return error(util.format("Got a %d response from SSO while creating client", response.statusCode));
    }
  });
}

function update_sso_client(access_token, client, id, error, next) {
  req.put(util.format("https://%s/auth/admin/realms/%s/clients/%s", config.SSO_HOSTNAME, config.SSO_REALM, id), {
    headers: {
      "Authorization": "Bearer " + access_token
    },
    json: client
  }, (err, response, body) => {
    if (err) {
      return error(err);
    }
    console.log("Got a %d response from SSO", response.statusCode);
    if (response.statusCode == 204) {
      try {
        next();
      } catch (err) {
        return error(err);
      }
    } else {
      return error(util.format("Got a %d response from SSO while updating client", response.statusCode));
    }
  });
}

function authenticate_to_sso(error, next) {
  console.log("Authenticating to SSO (realm = '%s') using the ROPC OAuth flow with %s/%s", config.SSO_REALM, config.SSO_SERVICE_USERNAME, config.SSO_SERVICE_PASSWORD);
  req.post(util.format("https://%s/auth/realms/%s/protocol/openid-connect/token", config.SSO_HOSTNAME, config.SSO_REALM), {
    form: {
      grant_type: "password",
      client_id: config.SSO_CLIENT_ID,
      username: config.SSO_SERVICE_USERNAME,
      password: config.SSO_SERVICE_PASSWORD
    }
  }, (err, response, body) => {
      if (err) {
        return error(err);
      }
      console.log("Got a %d response from SSO", response.statusCode);
      if (response.statusCode == 200) {
        try {
          var json_response = JSON.parse(body);
          console.log("Got an access token from SSO: %s", json_response.access_token);
          next(json_response.access_token);
        } catch (err) {
          return error(err);
        }
      } else {
        return error(util.format("Got a %d response from SSO while authenticating", response.statusCode));
      }
  });
}

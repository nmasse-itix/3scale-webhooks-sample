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

  // Handle optional environment variables
  if ('SSO_AUTH_REALM' in process.env && process.env.SSO_AUTH_REALM != null) {
    config.SSO_AUTH_REALM = process.env.SSO_AUTH_REALM;
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
  // Safety check: only create apps for OAuth enabled apps
  // We know that an app is OAuth enabled if there is a redirect_url
  // element in the webhooks payload. The element can be empty but it has to be there.
  if (!("redirect_url" in app)) {
    console.log("No redirect_url found in app description (not OAuth ?). Skipping client creation...");
    return next("No redirect_url found in app description (not OAuth ?)");
  }

  // Base Payload for app creation/update
  var client = {
    clientId: app.application_id,
    name: app.name,
    description: app.description
  };

  // Add the client_secret to the client creation payload when found
  if ('keys' in app && 'key' in app.keys && app.keys.key != null) {
    console.log("Found a client_secret : '%s'", app.keys.key);
    client.secret = app.keys.key;
    client.clientAuthenticatorType = "client-secret";
    client.publicClient = false;
  }

  // Add the redirect_url to the client creation payload when found
  if (app.redirect_url != null && app.redirect_url != "") {
    console.log("Found a redirect_url : '%s'", app.redirect_url);
    client.redirectUris = [ app.redirect_url ];
  }

  authenticate_to_sso(next, (access_token) => {
    get_sso_client(client.clientId, access_token, next, (sso_client) => {
      if (action == "updated" || action == "created") {
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
      } else if (action == "deleted") {
        if (sso_client == null) {
          console.log("Could not find a matching client...");
          return next('Nothing done, could not find a matching client.');
        }

        console.log("Deleting client with id = %s", sso_client.id);
        delete_sso_client(access_token, sso_client.id, next, (response) => {
          console.log("OK, client deleted !");
          next('SUCCESS');
        });
      } else {
        console.log("Unkown action '%s'", action);
        next(util.format("Unknown action '%s'", action));
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

function delete_sso_client(access_token, id, error, next) {
  req.delete(util.format("https://%s/auth/admin/realms/%s/clients/%s", config.SSO_HOSTNAME, config.SSO_REALM, id), {
    headers: {
      "Authorization": "Bearer " + access_token
    }
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
  var realm = config.SSO_AUTH_REALM || config.SSO_REALM;
  console.log("Authenticating to SSO (realm = '%s') using the ROPC OAuth flow with %s/%s", realm, config.SSO_SERVICE_USERNAME, config.SSO_SERVICE_PASSWORD);
  req.post(util.format("https://%s/auth/realms/%s/protocol/openid-connect/token", config.SSO_HOSTNAME, realm), {
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
        console.log("Error while authenticating to SSO.");
        if (config.SSO_AUTH_REALM == null && config.SSO_SERVICE_USERNAME == "admin" && config.SSO_REALM != "master") {
          console.log("It looks like you are trying to authenticate with the built-in 'admin'");
          console.log("user but you did not provide the SSO_AUTH_REALM environment variable.");
          console.log("Re-try with 'SSO_AUTH_REALM=master' !");
        }

        return error(util.format("Got a %d response from SSO while authenticating", response.statusCode));
      }
  });
}

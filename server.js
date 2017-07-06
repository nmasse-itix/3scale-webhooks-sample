// Dependencies
var express = require("express");
var _ = require("underscore");
var util = require('util');
var xmlparser = require('express-xml-bodyparser');

// ExpressJS Setup
var app = express();
var router = express.Router();
var port = 8080;

var my_url = "/webhook";
var shared_secret = process.env.SHARED_SECRET;
if (shared_secret == null || shared_secret == "") {
  shared_secret == null;
  console.log("WARNING: Authentication is DISABLED !");
  console.log("WARNING: Please add an environment variable named 'SHARED_SECRET' to enable authentication");
} else {
  my_url += util.format("?shared_secret=%s", encodeURIComponent(shared_secret));
}

//
var handler_registry = {
  application: [],
  user: [],
  account: []
};

// Register and init all handlers
var handlers = (process.env.WEBHOOKS_MODULES == null ? [] : process.env.WEBHOOKS_MODULES.split(","));
handlers = _.chain(handlers)
            .map((i) => { return i.trim(); })
            .reject((i) => { return i == ""; })
            .value();
if (handlers.length == 0) {
  console.log("WARNING: no handler registered ! This server won't do anything useful...");
  console.log("WARNING: Use the environment variable 'WEBHOOKS_MODULES' to pass a list of coma separated values of modules to load");
} else {
  console.log("Found %d webhooks handlers !", handlers.length);
}

var handler_state = {};
_.each(handlers, (i) => {
  var state = {};
  var handler = null;
  try {
    handler = require(util.format("./%s.js", i));
    state.loaded = true;
  } catch (e) {
    state.loaded = false;
    state.error = e.message || "UNKNOWN";
  }

  if (state.loaded) {
    try {
      handler.init();
      state.initialized = true;
    } catch (e) {
      state.initialized = false;
      state.error = e.message || "UNKNOWN";
    }
  }

  var registered_types = [];
  if (state.initialized) {
    try {
      registered_types = handler.register(_.keys(handler_registry));
      state.registered = true;
    } catch (e) {
      state.registered = false;
      state.error = e.message || "UNKNOWN";
    }
  }

  _.each(registered_types, (t) => {
    handler_registry[t].push({ name: i, handler: handler});
  });

  handler_state[i] = state;
});

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
    },
    handlersByType: _.mapObject(handler_registry, (v, k) => {
      return _.map(v, (i) => {
        return i.name;
      });
    }),
    handlersState: handler_state
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
  if (shared_secret != null && req.query.shared_secret != shared_secret) {
    return error(res, 403, "Wrong shared secret !")
  }

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

  if (!(type in handler_registry)) {
    return error(res, 412, util.format("No such type '%s'", type));
  }

  if (handler_registry[type].length > 0) {
    try {
      run_handlers(res, action, type, obj);
    } catch (e) {
      return error(res, 500, e.message);
    }
  } else {
    return error(res, 412, util.format("No handlers to handle '%s'", type));
  }
});

function run_handlers(res, action, type, obj) {
  var results = [];
  var next = () => {
    success(res, 200, results);
  };

  // Build the handler chain
  var handlers = pairs(handler_registry[type]);
  _.each(handlers, (i) => {
    var prev = i[0];
    var current = i[1];
    next = get_handler_wrapper(prev, current, next, results, action, type, obj);
  });

  // Run it
  next();
}

function get_handler_wrapper(prev, current, next, results, action, type, obj) {
  return (status) => {
    try {
      // Convert the status to string if needed
      if (status == null) {
        status = "UNKNOWN";
      } else if (status instanceof Error) {
        // Error objects translate to empty object during JSON serialization.
        // That's why we convert it to string before...
        status = status.toString();
      } // else, passthrough

      // Start of the loop, no status to fetch
      if (prev != null) {
        results.push({ name: prev.name, result: status });
      }

      // Call the next handler
      if (current != null) {
        current.handler.handle(action, type, obj, next);
      } else {
        next(); // End of the loop: call the last function to return results to caller
      }
    } catch (e) {
      if (next != null) {
        next(e);
      } else {
        console.log(e);
      }
    }
  };
}

// Converts an array as an array of pairs, in the reverse order.
//
// Example:
// [1, 2, 3] => [[3, null], [2, 3], [1, 2], [null, 1]]
//
function pairs(a) {
  var r = [];
  r.push([a[a.length - 1], null]);
  for (var i = a.length - 1; i > 0; i--) {
    r.push([a[i-1], a[i]]);
  }
  r.push([null, a[0]]);
  return r;
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

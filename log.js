function log_init() {
  // Nothing to do
}

function log_register(types) {
  return types; // We register for all types
}

function log_handle(action, type, app, next) {
  console.log("--> WEBHOOK: action = '%s', type = '%s'", action, type);
  console.log(app);
  next('SUCCESS');
}

exports.handle = log_handle;
exports.register = log_register;
exports.init = log_init;

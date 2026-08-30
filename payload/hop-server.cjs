"use strict";

var fs = require("fs");
var http = require("http");
var hop = require("./hop-handler.cjs");

var HOST = process.env.OPENBOT_HOP_HOST || "127.0.0.1";
var PORT = Number(process.env.OPENBOT_HOP_PORT || "9280");
var PID_FILE = process.env.OPENBOT_HOP_PID;

var server = http.createServer(function (req, res) {
  hop.handleHopRequest(req, res).then(function (handled) {
    if (!handled) {
      hop.sendJson(res, 404, { error: { message: "not found" } });
    }
  }).catch(function () {
    if (!res.headersSent) {
      hop.sendJson(res, 502, { error: { message: "hop failed" } });
    }
  });
});

server.listen(PORT, HOST, function () {
  if (PID_FILE) {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid) + "\n");
    } catch (err) {
      /* ignore */
    }
  }
  process.stdout.write("openbot-hop listening on " + HOST + ":" + String(PORT) + "\n");
});

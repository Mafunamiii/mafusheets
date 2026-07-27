"use strict";

const { openDatabase } = require("../../lib/database");

const db = openDatabase(process.argv[2]);
db.exec("BEGIN IMMEDIATE");
if (process.send) process.send({ locked: true });
setTimeout(() => {
  db.exec("ROLLBACK");
  db.close();
  process.exit(0);
}, Number(process.argv[3] || 6200));

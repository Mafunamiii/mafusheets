"use strict";

const path = require("path");
const { openDatabase } = require("./database");
const { createUserStore } = require("./users");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

async function main() {
  const command = process.argv[2];
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "mafusheets.sqlite");
  const db = openDatabase(databasePath);
  const users = createUserStore(db);
  try {
    if (command === "create-user") {
      const password = process.env.MAFUSHEETS_NEW_PASSWORD;
      if (!password) throw new Error("Set MAFUSHEETS_NEW_PASSWORD for the new account.");
      const user = await users.createUser({
        loginIdentifier: argumentValue("--login"),
        displayName: argumentValue("--display-name"),
        password,
        role: argumentValue("--role") || "member",
        mustChangePassword: process.argv.includes("--must-change-password")
      });
      console.log(`Created ${user.role} account ${user.loginIdentifier} (${user.id}).`);
      return;
    }
    if (command === "disable-user" || command === "enable-user") {
      const user = users.setEnabled(argumentValue("--id"), command === "enable-user");
      console.log(`${user.enabled ? "Enabled" : "Disabled"} account ${user.loginIdentifier}.`);
      return;
    }
    if (command === "list-users") {
      for (const user of users.listUsers()) {
        console.log(`${user.id}\t${user.role}\t${user.enabled ? "enabled" : "disabled"}\t${user.loginIdentifier}\t${user.displayName}`);
      }
      return;
    }
    throw new Error(
      "Usage: create-user --login LOGIN --display-name NAME --role admin|member | disable-user --id ID | enable-user --id ID | list-users"
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

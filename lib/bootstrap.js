"use strict";

const path = require("path");
const { EMERGENCY_ACTOR_ID, openDatabase } = require("./database");
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
    const changing = new Set([
      "create-user", "disable-user", "enable-user", "reset-password", "change-role"
    ]);
    let operator = null;
    if (changing.has(command)) {
      const operatorIdentifier = argumentValue("--operator");
      const emergency = process.argv.includes("--emergency-system-actor");
      if ((operatorIdentifier && emergency) || (!operatorIdentifier && !emergency)) {
        throw new Error(
          "Supply exactly one of --operator LOGIN_OR_ID or --emergency-system-actor."
        );
      }
      if (emergency) {
        operator = { actorUserId: EMERGENCY_ACTOR_ID, mode: "emergency-system" };
      } else {
        const row = db.prepare(`
          SELECT id FROM users
          WHERE is_system=0 AND enabled=1 AND role='admin'
            AND (id=? OR login_identifier=? COLLATE NOCASE)
        `).get(operatorIdentifier, operatorIdentifier);
        if (!row) throw new Error("--operator must identify an enabled administrator.");
        operator = { actorUserId: row.id, mode: "administrator" };
      }
    }
    if (command === "create-user") {
      const password = process.env.MAFUSHEETS_NEW_PASSWORD;
      if (!password) throw new Error("Set MAFUSHEETS_NEW_PASSWORD for the new account.");
      const user = await users.createUser({
        loginIdentifier: argumentValue("--login"),
        displayName: argumentValue("--display-name"),
        password,
        role: argumentValue("--role") || "member",
        mustChangePassword: process.argv.includes("--must-change-password"),
        operator
      });
      console.log(`Created ${user.role} account ${user.loginIdentifier} (${user.id}).`);
      return;
    }
    if (command === "disable-user" || command === "enable-user") {
      const user = users.setEnabled(
        argumentValue("--id"), command === "enable-user", operator
      );
      console.log(`${user.enabled ? "Enabled" : "Disabled"} account ${user.loginIdentifier}.`);
      return;
    }
    if (command === "reset-password") {
      const password = process.env.MAFUSHEETS_NEW_PASSWORD;
      if (!password) throw new Error("Set MAFUSHEETS_NEW_PASSWORD for the replacement password.");
      const user = await users.resetPassword(argumentValue("--id"), password, {
        mustChangePassword: !process.argv.includes("--no-required-change"),
        operator
      });
      console.log(`Reset password for ${user.loginIdentifier}; active sessions were revoked.`);
      return;
    }
    if (command === "change-role") {
      const user = users.setRole(
        argumentValue("--id"), argumentValue("--role"), operator
      );
      console.log(`Changed ${user.loginIdentifier} to ${user.role}; active sessions were revoked.`);
      return;
    }
    if (command === "list-users") {
      for (const user of users.listUsers()) {
        console.log(`${user.id}\t${user.role}\t${user.enabled ? "enabled" : "disabled"}\t${user.loginIdentifier}\t${user.displayName}`);
      }
      return;
    }
    throw new Error(
      "Usage: account-changing commands require --operator LOGIN_OR_ID or --emergency-system-actor. Commands: create-user --login LOGIN --display-name NAME --role admin|member | disable-user --id ID | enable-user --id ID | reset-password --id ID | change-role --id ID --role admin|member | list-users"
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

// @ts-check
// An in-memory stand-in for kagan/database, backed by Node's built-in SQLite.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const applied = new Set();

export async function migrate(statements) {
  for (const sql of statements) {
    if (applied.has(sql)) continue;
    db.exec(sql);
    applied.add(sql);
  }
}

export async function query(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export async function run(sql, params = []) {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}

export async function transaction(statements) {
  db.exec("BEGIN");
  try {
    for (const statement of statements) {
      if (typeof statement === "string") db.exec(statement);
      else db.prepare(statement.sql).run(...(statement.params ?? []));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

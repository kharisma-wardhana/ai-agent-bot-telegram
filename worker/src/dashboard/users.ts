/**
 * Dashboard users: bootstrap owners (config, can't be removed) + users added from the dashboard
 * (docs/mentor-followup-dashboard/spec.md › Managing mentors, AC 7, 18).
 */
import type { Deps } from "../deps";
import { normEmail, type DashUser } from "./auth";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Everyone who can sign in: owners first, then added users (an added row shadowed by an owner email is hidden). */
export async function listUsers(d: Deps): Promise<DashUser[]> {
  const owners: DashUser[] = d.cfg.dashboardOwners.map((o) => ({ email: o.email, displayName: o.displayName, telegramId: o.telegramId, bootstrap: true, id: null }));
  const ownerEmails = new Set(owners.map((o) => o.email));
  const added = (await d.repo.listDashboardUsers())
    .filter((u) => !ownerEmails.has(u.email))
    .map((u): DashUser => ({ email: u.email, displayName: u.displayName, telegramId: u.telegramId, bootstrap: false, id: u.id }));
  return [...owners, ...added];
}

export type AddResult = "added" | "invalid" | "exists";

export async function addUser(d: Deps, by: DashUser, input: { name: string; email: string; telegramId: string }): Promise<AddResult> {
  const name = input.name.trim();
  const email = normEmail(input.email);
  const tid = input.telegramId.trim();
  if (!name || name.length > 60 || !EMAIL.test(email) || email.length > 254 || !/^[1-9][0-9]{0,14}$/.test(tid)) return "invalid";
  if (d.cfg.dashboardOwners.some((o) => o.email === email)) return "exists";
  const id = await d.repo.addDashboardUser({ email, displayName: name, telegramId: Number(tid), addedByEmail: by.email });
  return id === null ? "exists" : "added";
}

/** Removes an added user and revokes their sessions and pending login links. */
export async function removeUser(d: Deps, id: number): Promise<boolean> {
  return (await d.repo.removeDashboardUser(id)) !== null;
}

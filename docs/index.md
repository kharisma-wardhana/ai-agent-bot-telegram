# Documentation index

Project-wide review checklist: [REVIEW.md](../REVIEW.md)

## Features
- **telegram-rag-learning-companion**: Telegram #askAI learning companion with RAG over lesson-docs
  - [intent.md](telegram-rag-learning-companion/intent.md)
  - [spec.md](telegram-rag-learning-companion/spec.md)
  - [plan.md](telegram-rag-learning-companion/plan.md)
  - [tasks.md](telegram-rag-learning-companion/tasks.md)
  - [setup.md](telegram-rag-learning-companion/setup.md): operator setup, deploy, eval and rollback
  - [ops-tools.md](telegram-rag-learning-companion/ops-tools.md): deploy/status/rollback as scoped MCP tools (documented, not wired)
  - [pr.md](telegram-rag-learning-companion/pr.md): pull/merge request description, ready to paste
  - [monitoring.md](telegram-rag-learning-companion/monitoring.md): control band on the fallback rate, response tiers, incident template, security scan, loop closure
- **mentor-followup-dashboard**: phone-friendly web dashboard where mentors claim and reply to follow-up questions; the bot relays replies to learners
  - [intent.md](mentor-followup-dashboard/intent.md)
  - [spec.md](mentor-followup-dashboard/spec.md)
  - [plan.md](mentor-followup-dashboard/plan.md)
  - [tasks.md](mentor-followup-dashboard/tasks.md)
  - [setup.md](mentor-followup-dashboard/setup.md): migration 0004, the two new Worker vars, first login, daily use, rollback
  - [ops-tools.md](mentor-followup-dashboard/ops-tools.md): dashboard additions to deploy/status/rollback (documented, not wired)
  - [pr.md](mentor-followup-dashboard/pr.md): pull request description, ready to paste
  - [monitoring.md](mentor-followup-dashboard/monitoring.md): reuses the fallback-rate control band; weekly delivery/claim checks; loop closure
- **cohort-welcome-message**: automatic batched welcome for new cohort members (dashboard-editable text); leave notices DMed to dashboard users
  - [intent.md](cohort-welcome-message/intent.md)
  - [spec.md](cohort-welcome-message/spec.md)
  - [plan.md](cohort-welcome-message/plan.md)
  - [tasks.md](cohort-welcome-message/tasks.md)
  - [setup.md](cohort-welcome-message/setup.md): migration 0005, admin rights + webhook re-registration with chat_member, Sambutan page, rollback
  - [ops-tools.md](cohort-welcome-message/ops-tools.md): additions to the documented (not wired) ops tools
  - [pr.md](cohort-welcome-message/pr.md): pull request description, ready to paste
  - [monitoring.md](cohort-welcome-message/monitoring.md): cohort-day checklist, weekly waiting-list check, loop closure

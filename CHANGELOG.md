# Changelog / 更新日志

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

本项目的重要变更都记在这里，格式参照 Keep a Changelog。

## [0.1.0-alpha.4.8] - unreleased

Plugin `0.1.0-alpha.4.8`, Chrome extension `0.2.14` (unchanged).

### Fixed / 修复

- Server: at the session cap (100), `create()` now evicts the least recently active sessions that are idle or abandoned, not attached to a Paseo agent and have no pending command. Previously sessions were never deleted, so once 100 were stored every new Chatmode agent failed with `SESSION_LIMIT`. ([#5](https://github.com/Project10214/chatmode-in-paseo/pull/5))
  会话存满 100 个时，新建会话会自动清掉最久没用、空闲、没被 Paseo 挂着、也没有待办命令的旧会话；以前会话从不删除，存满后新员工一律报 `SESSION_LIMIT`。

## [0.1.0-alpha.4.7] - 2026-10-16

First public release under the name Chatmode in Paseo (renamed from CoS in Paseo). See the commit history before this entry.

以 Chatmode in Paseo 为名的首个公开版本（原名 CoS in Paseo），此前的变更见提交记录。

[0.1.0-alpha.4.8]: https://github.com/Project10214/chatmode-in-paseo/compare/986da1a...HEAD
[0.1.0-alpha.4.7]: https://github.com/Project10214/chatmode-in-paseo/commit/986da1a

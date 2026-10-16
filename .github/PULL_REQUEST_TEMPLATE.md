<!-- Please write in English or 中文. 请用中文或英文填写。 -->

## Summary / 变更说明

<!-- What does this pull request change, and why? / 这个 PR 改了什么、为什么要改？ -->

## Related issue / 关联 Issue

<!-- e.g. Closes #123 / 例如：Closes #123 -->

## Type of change / 变更类型

- [ ] Bug fix / 修复问题
- [ ] New feature / 新功能
- [ ] Documentation / 文档
- [ ] Refactor, tests or CI / 重构、测试或 CI

## How was it tested? / 如何验证？

- [ ] `npm run check`
- [ ] `npm run verify:upstream`
- [ ] `npm test`
- [ ] `npm run typecheck` and `npm run test:sdk` (when touching TypeScript or the Paseo interface / 涉及 TypeScript 或 Paseo 接口时)
- [ ] Browser tests or a manual test in real Chrome (describe below / 请在下方说明)

<!--
Changes that need a real logged-in ChatGPT session cannot be covered by CI. Please describe how you tested them by hand.
需要真实登录的 ChatGPT 会话才能验证的改动无法由 CI 覆盖，请说明你的手动测试情况。
-->

## Checklist / 确认事项

- [ ] No secrets, tokens, pairing codes or private conversation content in code, tests, logs or screenshots / 代码、测试、日志、截图中没有密钥、令牌、配对码或私人对话内容
- [ ] If I changed `extension/upstream/*.js`, I updated `vendor/cos/provenance.json` and `vendor/cos/README.md` / 如修改了 `extension/upstream/*.js`，已同步更新 `vendor/cos/provenance.json` 与 `vendor/cos/README.md`
- [ ] Docs are updated where behavior changed / 行为有变化的地方已更新文档
- [ ] I agree that my contribution is licensed under the project's MIT License / 我同意以本项目的 MIT 许可证授权我的贡献

/**
 * Oryn：Hindsight 项目标识（见 ORYN.md「例外清单」）。
 *
 * Oryn 的 orb 里所有项目的工作目录都是 `~/workspace/repo`，按目录推出的项目标签会全部变成
 * `project:repo`。orbd 在 agent.start 时把控制面的项目 ID 放进 `ORYN_HINDSIGHT_PROJECT`，
 * 这里优先用它作为项目标签；未设置或为空白时返回 undefined，沿用上游按目录推导的行为。
 */

/** orbd 注入项目 ID 用的环境变量名。 */
export const ORYN_HINDSIGHT_PROJECT_ENV = "ORYN_HINDSIGHT_PROJECT";

/** 返回 Oryn 注入的项目标签（去掉首尾空白并转小写）；未设置或为空白时返回 undefined。 */
export function orynProjectLabel(): string | undefined {
	const raw = process.env[ORYN_HINDSIGHT_PROJECT_ENV]?.trim();
	return raw ? raw.toLowerCase() : undefined;
}

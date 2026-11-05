/** Conservative, dependency-free first gate for opt-in automatic workflow activation.
 * This classifies whether to start the workflow, NOT FAST vs STANDARD.
 * Mode selection is delegated to the agent AFTER it inspects the repository.
 */
export function isActionableDevelopmentRequest(raw: string): boolean {
  const text = raw.trim();
  if (!text || text.length > 8000 || text.startsWith("/") || text.startsWith("!") || text.startsWith("#")) return false;

  const directRequest = /(?:帮我|请(?:你|帮忙)?|麻烦(?:你)?|给我|需要你|希望你|请直接|can you|could you|please|i need you to|i want you to)/i.test(text);
  const questionLead = /^(?:怎么|如何|为什么|为何|什么是|是否|能否|可以(?:吗|解释|介绍|说说)|请问|介绍|解释|讲讲|比较|对比|what\b|why\b|how\b|where\b|when\b|which\b|is\b|are\b|does\b|do\b)/i.test(text);
  // Asking about development is not an instruction to change code.
  if (questionLead && !directRequest) return false;

  const codeContext = /(?:代码|源码|仓库|项目|函数|方法|组件|CI\b|按钮|表单|页面|界面|接口|api\b|服务端|前端|后端|数据库|schema\b|类型|编译|构建|测试|单测|脚本|配置|依赖|模块|bug\b|报错|错误|异常|pr\s*#?\d+|merge request|mr\s*#?\d+|pull request|git\b|react\b|vue\b|node(?:\.js)?\b|typescript\b|javascript\b|python\b|功能|插件|扩展|端点|路由|登录|权限|样式|css\b|cli\b|代码库|algorithm|code\b|repo(?:sitory)?\b|function\b|component\b|button\b|form\b|endpoint\b|build\b|test(?:s)?\b|lint\b|fix(?:ing)?\b|login\b|feature\b|refactor\b)/i.test(text);
  if (!codeContext) return false;

  const chineseAction = /(?:修复|修一下|修正|改掉|改一下|修改|更改|调整|调大|调小|增加|添加|新增|实现|开发|做个|做一个|重构|优化|删掉|删除|移除|替换|完善|升级|迁移|接入|集成|补充|补上|补一个|补测试|写一个|写一下|编写|处理|排查|排查并修复|解决|搭建|更新|帮我改|让.{0,25}(?:支持|能够)|把.{0,60}(?:改成|改为|替换为|修好|调大|调小))/i;
  const englishAction = /\b(?:fix|implement|add|update|remove|refactor|change|build|create|integrate|upgrade|migrate|write|patch|develop|debug|correct)\b/i;
  return chineseAction.test(text) || englishAction.test(text);
}

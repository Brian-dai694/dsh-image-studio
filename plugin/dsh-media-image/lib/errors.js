// 生成/局部重绘后端的统一错误类型。
// 单独一层，避免 generation.js 与各 provider 模块互相 import 形成循环依赖。

export class GenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    Object.assign(this, details);
  }
}

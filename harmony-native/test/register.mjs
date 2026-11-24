// 用法：node --import ./test/register.mjs --test "test/*.test.ts"（或 scripts/test.sh）
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

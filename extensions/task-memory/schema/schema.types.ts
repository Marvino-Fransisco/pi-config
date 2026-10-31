import type { Static } from "typebox";
import type { Params } from "./schema.ts";

export type TaskParams = Static<typeof Params>;

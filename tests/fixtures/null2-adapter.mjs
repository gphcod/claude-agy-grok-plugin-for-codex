// A second test provider (S2.8): the null adapter under the id "null2", so entry tests can bind threads and request ids
// to two providers. Loaded by the entry only under COUNCIL_TEST_NULL_ADAPTER=1.
import base from "./null-adapter.mjs";

export default { ...base, id: "null2", binEnv: "COUNCIL_NULL2_BIN" };

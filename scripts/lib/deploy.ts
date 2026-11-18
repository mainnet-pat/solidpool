// Make pools through their factories, as the browser does: one module, so the scripts, the
// service's devnet and the tests send the transactions the page sends.
export {
  planProblems, plansProblems, deployPoolWithSigner as deployPool, type PoolPlan,
} from '../../web/src/deploy-pool';

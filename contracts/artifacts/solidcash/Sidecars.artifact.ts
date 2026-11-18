export default {
  contractName: 'definitions',
  constructorInputs: [],
  abi: [],
  bytecode: '',
  source: 'pragma solidcash ^0.51.0;\n\n// Written by scripts/sidecar-locks.ts; `npm run check` refuses a copy that differs.\n//\n// The locks of the coins a pool spends beside its master, the same for every pool: MimcHash\'s,\n// and the Groth16 verifier\'s (service/verifier/verifier-artifact-3in.json). A pool pins them, so\n// it reads only coins that ran that code. Neither code names a pool: anyone can make a coin of\n// either lock, and anyone can sweep one that has stood unmoved for 1,440 blocks, as its\n// transaction\'s only input.\n\nbytes constant WORKER_LOCK = 0xaa208f0006560c63c65fb44f21d423201d3aa1d78db6540f90a62749d66d54e90d0987;\nbytes constant VERIFIER_LOCK = 0xaa2078b6a25e488c1694549d41a04f7d07a94075eb31db539ca3fef395176eb31b7087;\n',
  isLibrary: true,
  compiler: {
    name: 'solidc',
    version: '0.51.1',
    options: {},
  },
  updatedAt: '2026-11-17T09:55:20.146Z',
} as const;

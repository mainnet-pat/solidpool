// In-browser Groth16 prover. websnark's browser bundle runs its WASM prover in Web
// Workers, so the proving key and circuit stay in the user's browser. The bundle is the
// package's browserify build: no Node worker/crypto path and no bundler aliases.

/** What the prover needs of websnark's browser build. */
interface Websnark {
  genZKSnarkProofAndWitness: (input: unknown, circuit: unknown, key: ArrayBuffer) => Promise<any>;
  zkSnarkProofToSolidityInput: (proof: any) => { proof: string; publicSignals: string[] };
}

/** The window globals websnark's build sets once its workers are up. */
const WEBSNARK_GLOBALS = ['groth16', 'genZKSnarkProofAndWitness', 'genZKSnarkProof', 'zkSnarkProofToSolidityInput'];

let proverReady: Promise<Websnark> | null = null;

/**
 * Load websnark and keep its two entry points here. They are taken once and deleted from
 * window, so nothing that runs on the page later can put another function where a proof's
 * witness, the note's secret and nullifier, would be handed to it.
 */
const ensureProver = (): Promise<Websnark> => {
  proverReady ??= (async () => {
    // @ts-ignore -- the browserify build has no declarations
    await import('websnark/build/websnark.js');
    const page = window as any;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (page.groth16 && page.genZKSnarkProofAndWitness && page.zkSnarkProofToSolidityInput) {
        const websnark: Websnark = {
          genZKSnarkProofAndWitness: page.genZKSnarkProofAndWitness,
          zkSnarkProofToSolidityInput: page.zkSnarkProofToSolidityInput,
        };
        for (const name of WEBSNARK_GLOBALS) delete page[name];
        return websnark;
      }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    throw new Error('The prover did not start.');
  })();
  // A prover that failed to start is tried again by the next proof.
  proverReady.catch(() => { proverReady = null; });
  return proverReady;
};

export interface ProverAssets {
  circuitUrl: string;
  provingKeyUrl: string;
}

export interface ProofFixture {
  publicInputs: string[];
  proof: {
    a: { x: string; y: string };
    b: { x: { c0: string; c1: string }; y: { c0: string; c1: string } };
    c: { x: string; y: string };
  };
}

// The circuit and proving key of the public trusted setup, by content. A server or CDN that
// serves anything else is refused here, before it reaches the prover.
const CIRCUIT_SHA256 = '3ddd61dbff09caeec82d8edde95c674a3c34f9e66b1fe9f2c8783e72fe536f98';
const PROVING_KEY_SHA256 = '8e2d2f22beafb5a9666daebca57b13f8029c3656c65fcfbcc86e2418fa16a3af';

async function pinned(url: string, expected: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`prover asset ${url}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error(`prover asset ${url} is not the published one`);
  return bytes;
}

let circuit: Promise<any> | null = null;
let provingKey: Promise<ArrayBuffer> | null = null;
let assetKey = '';

export async function prepareProver(assets: ProverAssets, onProgress?: (message: string) => void): Promise<void> {
  const key = `${assets.circuitUrl}|${assets.provingKeyUrl}`;
  if (key !== assetKey) {
    assetKey = key;
    circuit = null;
    provingKey = null;
  }
  onProgress?.('Loading circuit…');
  circuit ??= pinned(assets.circuitUrl, CIRCUIT_SHA256).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
  // A failed download must not stay failed until the page reloads.
  circuit.catch(() => { circuit = null; });
  onProgress?.('Loading proving key (14 MB)…');
  provingKey ??= pinned(assets.provingKeyUrl, PROVING_KEY_SHA256);
  provingKey.catch(() => { provingKey = null; });
  onProgress?.('Starting the prover…');
  // websnark sizes its worker pool from navigator.hardwareConcurrency; a
  // large host would spawn dozens of WASM workers and their initial memories.
  try {
    if (navigator.hardwareConcurrency > 4) {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 4, configurable: true });
    }
  } catch { /* older browsers do not allow overriding it */ }
  await circuit;
  onProgress?.('Circuit loaded.');
  await provingKey;
  onProgress?.('Proving key loaded.');
  await ensureProver();
  onProgress?.('Prover ready.');
}

export async function prove(
  input: Record<string, unknown>,
  assets: ProverAssets,
  onProgress?: (message: string) => void,
): Promise<ProofFixture> {
  await prepareProver(assets, onProgress);
  const [circuitJson, key, websnark] = await Promise.all([circuit!, provingKey!, ensureProver()]);
  onProgress?.('Generating the Groth16 proof…');
  const proofData = await websnark.genZKSnarkProofAndWitness(input, circuitJson, key);
  const { proof, publicSignals } = websnark.zkSnarkProofToSolidityInput(proofData);
  const blob = String(proof).replace(/^0x/, '');
  const word = (index: number) => BigInt('0x' + blob.slice(index * 64, index * 64 + 64)).toString();
  return {
    publicInputs: publicSignals.slice(0, 3).map((value: string) => BigInt(value).toString()),
    proof: {
      a: { x: word(0), y: word(1) },
      b: { x: { c0: word(3), c1: word(2) }, y: { c0: word(5), c1: word(4) } },
      c: { x: word(6), y: word(7) },
    },
  };
}

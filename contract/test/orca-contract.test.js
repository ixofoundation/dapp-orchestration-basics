// @ts-check

/* eslint-disable import/order -- https://github.com/endojs/endo/issues/1235 */
import { test as anyTest } from './prepare-test-env-ava.js';

import { createRequire } from 'module';
import { E, Far, passStyleOf } from '@endo/far';
import { makeNodeBundleCache } from '@endo/bundle-source/cache.js';
import { AmountMath } from '@agoric/ertp';
import { registerChain } from '@agoric/orchestration/src/chain-info.js';
import { prepareVowTools } from '@agoric/vow/vat.js';

import { startOrcaContract } from '../src/orca.proposal.js';

import { makeMockTools, mockBootstrapPowers } from './boot-tools.js';
import { getBundleId } from '../tools/bundle-tools.js';
import { startOrchCoreEval } from '../tools/startOrch.js';

import { makeHeapZone } from '@agoric/zone';
import { prepareSwingsetVowTools } from '@agoric/vow/vat.js';

/** @typedef {typeof import('../src/orca.contract.js').start} OrcaContractFn */
/**
 * @import {ChainInfo, IBCConnectionInfo, IcaAccount, MakeCosmosInterchainService} from '@agoric/orchestration';
 * @import {LocalChain,LocalChainAccount} from '@agoric/vats/src/localchain.js';
 * @import {TargetRegistration} from '@agoric/vats/src/bridge-target.js';
 */

const nodeRequire = createRequire(import.meta.url);

const contractPath = nodeRequire.resolve(`../src/orca.contract.js`);
const scriptRoot = {
  orca: nodeRequire.resolve('../src/orca.proposal.js'),
};
// const scriptRoots = {
//   postalService: nodeRequire.resolve('../src/postal-service.proposal.js'),
// };

/** @type {import('ava').TestFn<Awaited<ReturnType<makeTestContext>>>} */
// @ts-expect-error - XXX what's going on here??
const test = anyTest;

/** @type {IBCConnectionInfo} */
const c1 = harden({
  id: 'connection-0',
  client_id: 'client-0',
  state: 3, // OPEN
  counterparty: harden({
    client_id: 'client-0',
    connection_id: 'connection-0',
    prefix: {
      key_prefix: 'key-prefix-0',
    },
  }),
  transferChannel: harden({
    portId: 'transfer',
    channelId: 'channel-0',
    counterPartyPortId: 'transfer',
    counterPartyChannelId: 'channel-1',
    ordering: 2, // ORDERED
    version: '1',
    state: 3, // OPEN
  }),
});

/** @type {Record<string, ChainInfo>} */
const chainInfo = harden({
  agoric: {
    chainId: `agoriclocal`,
    stakingTokens: [{ denom: 'ubld' }],
    connections: { osmosislocal: c1 },
  },
  osmosis: {
    chainId: `osmosislocal`,
    stakingTokens: [{ denom: 'uosmo' }],
    connections: { agoriclocal: c1 },
  },
});

/**
 * Tests assume access to the zoe service and that contracts are bundled.
 *
 * See test-bundle-source.js for basic use of bundleSource().
 * Here we use a bundle cache to optimize running tests multiple times.
 *
 * @param {import('ava').ExecutionContext} t
 */
const makeTestContext = async t => {
  const { powers } = await mockBootstrapPowers(t.log);

  const bundleCache = await makeNodeBundleCache('bundles/', {}, s => import(s));
  const bundle = await bundleCache.load(contractPath, 'orca');
  const tools = await makeMockTools(t, bundleCache);

  const { agoricNamesAdmin } = await powers.consume;

  for (const [name, info] of Object.entries(chainInfo)) {
    await registerChain(agoricNamesAdmin, name, info);
  }

  const zones = {
    cosmos: powers.zone.subZone('cosmosInterchainService'),
  };

  const cVowTools = prepareVowTools(zones.cosmos);

  /** @type {ReturnType<MakeCosmosInterchainService>} */
  const cosmosInterchainService = Far('CosmosInterchainService mock', {
    makeAccount: (chainId, _host, _controller, _opts) => {
      const denom = chainId.startsWith('agoric') ? 'ubld' : 'uosmo';

      /** @type {IcaAccount} */
      const account = Far('Account', {
        getChainId: () => chainId,
        getAccountAddress: () => `${chainId}AccountAddress`,
        getAddress: () =>
          harden({
            chainId,
            value: `${chainId}AccountAddress`,
            encoding: 'bech32',
          }),
        getBalance: () => `1000${denom}`,
        deactivate: () => assert.fail(`mock 1`),
        executeEncodedTx: () => assert.fail(`mock 2`),
        executeTx: () => assert.fail(`mock 3`),
        getLocalAddress: () => '/ibc-port/xyz',
        getPort: () => assert.fail(`mock 4`),
        getRemoteAddress: () => '/x/ibc-port/y/ordered/z',
        reactivate: () => assert.fail(`mock 6`),
      });

      return cVowTools.asVow(() => account);
    },
    provideICQConnection(_controllerConnectionId, _version) {
      throw Error('mock');
    },
  });

  /** @type {LocalChain} */
  const localchain = Far('Localchain mock', {
    async makeAccount() {
      /** @type {LocalChainAccount} */
      const acct = Far('LocalChainAccount mock', {
        getAddress() {
          return 'agoric123';
        },
        getBalance() {
          throw Error('mock TODO getBalance');
        },
        deposit() {
          throw Error('mock TODO makeAccount');
        },
        withdraw() {
          throw Error('mock TODO withdraw');
        },
        executeTx() {
          throw Error('mock TODO makeexecuteTxAccount');
        },
        async monitorTransfers(_tap) {
          /** @type {TargetRegistration} */
          const reg = Far('TR mock', {
            revoke() {
              throw Error('TODO revoke');
            },
            updateTargetApp() {
              throw Error('TODO updateTargetApp');
            },
          });
          return reg;
        },
      });
      return acct;
    },
    query() {
      throw Error('mock TODO query');
    },
    queryMany() {
      throw Error('mock TODO queryMany');
    },
  });

  const vowTools = prepareVowTools(powers.zone);

  return {
    bundle,
    bundleCache,
    cosmosInterchainService,
    localchain,
    vowTools,
    bootstrapSpace: powers.consume,
    ...tools,
  };
};

test.before(async t => (t.context = await makeTestContext(t)));

test('Install the contract', async t => {
  const { bootstrapSpace, bundle } = t.context;
  const { zoe } = bootstrapSpace;
  const installation = await E(zoe).install(bundle);
  t.log('installed:', installation);
  t.is(typeof installation, 'object');
});

test('Start Orca contract', async t => {
  const { bundle, bootstrapSpace, cosmosInterchainService, localchain } =
    t.context;
  const { zoe } = bootstrapSpace;
  const installation = await E(zoe).install(bundle);

  const privateArgs = harden({
    orchestrationService: cosmosInterchainService,
    storageNode: await bootstrapSpace.chainStorage,
    marshaller: await E(bootstrapSpace.board).getPublishingMarshaller(),
    timerService: await bootstrapSpace.chainTimerService,
    localchain,
    agoricNames: await bootstrapSpace.agoricNames,
  });

  const { instance } = await E(zoe).startInstance(
    installation,
    {},
    {},
    privateArgs,
  );
  t.log('started:', instance);
  t.truthy(instance);
});

test('Start Orca contract using core-eval', async t => {
  const { runCoreEval, installBundles, makeQueryTool } = t.context;
  // const { runCoreEval, installBundles } = t.context;

  t.log('run core-eval to start (dummy) orchestration 2');
  t.log('runCoreEval:', runCoreEval);
  t.log('before core eval');
  await runCoreEval({
    name: 'start-orchestration',
    behavior: startOrchCoreEval,
    entryFile: 'not used',
    config: {},
  });

  t.log('before install');
  const bundles = await installBundles({ orca: contractPath });

  t.log('run orca core-eval');
  t.log(`${bundles.orca}`);
  const bundleID = getBundleId(bundles.orca);
  t.log('bundleID');
  t.log(bundleID);
  const name = 'orca';
  try {
    const result = await runCoreEval({
      name,
      behavior: startOrcaContract,
      entryFile: scriptRoot.orca,
      config: {
        options: { orca: { bundleID } },
      },
    });

    t.log('runCoreEval finished with status:', result);
    t.is(result.status, 'PROPOSAL_STATUS_PASSED');
  } catch (error) {
    t.log('Error during runCoreEval:', error);
    throw error;
  }

  const qt = makeQueryTool();
  const instance = await qt
    .queryData('published.agoricNames.instance')
    .then(es => Object.fromEntries(es));
  t.log(instance[name]);
});

export const chainConfigs = {
  cosmoshub: {
    chainId: 'gaialocal',
    denom: 'uatom',
    expectedAddressPrefix: 'cosmos',
  },
  osmosis: {
    chainId: 'osmosislocal',
    denom: 'uosmo',
    expectedAddressPrefix: 'osmo',
  },
  agoric: {
    chainId: 'agoriclocal',
    denom: 'ubld',
    expectedAddressPrefix: 'agoric',
  },
};

const orchestrationAccountScenario = test.macro({
  title: (_, chainName) =>
    `orchestrate - ${chainName} makeAccount returns a ContinuingOfferResult`,
  exec: async (t, chainName) => {
    const {
      bundle,
      cosmosInterchainService,
      localchain,
      bootstrapSpace,
      vowTools: vt,
    } = t.context;
    const { zoe } = bootstrapSpace;

    t.log('installing the contract...'); // why are we doing this again???
    /** @type {Installation<OrcaContractFn>} */
    const installation = await E(zoe).install(bundle);

    const privateArgs = harden({
      orchestrationService: cosmosInterchainService,
      storageNode: await bootstrapSpace.chainStorage,
      marshaller: await E(bootstrapSpace.board).getPublishingMarshaller(),
      timerService: await bootstrapSpace.chainTimerService,
      localchain,
      agoricNames: await bootstrapSpace.agoricNames,
    });

    t.log('starting the instance...');
    const { instance } = await E(zoe).startInstance(
      installation,
      {},
      {},
      privateArgs,
    );
    const publicFacet = await E(zoe).getPublicFacet(instance);

    t.log('creating account invitation...');
    const toMakeAccount = await E(publicFacet).makeAccountInvitation();

    t.log('making offer...', chainName);
    const seat = await E(zoe).offer(toMakeAccount, {}, undefined, {
      chainName,
    });

    const offerResult = await vt.when(E(seat).getOfferResult());
    t.log('offer result:', offerResult);
    t.is(
      passStyleOf(offerResult.invitationMakers),
      'remotable',
      'Offer include invitationMakers',
    );
    t.like(offerResult, {
      publicSubscribers: {
        account: {
          description: 'Staking Account holder status',
          storagePath: 'mockChainStorageRoot.osmosislocalAccountAddress',
        },
      },
    });
  },
});

const orchestrationAccountAndFundScenario = test.macro({
  title: (_, chainName) =>
    `orchestrate - ${chainName} makeAccount and fund returns a ContinuingOfferResult`,
  exec: async (t, chainName) => {
    const {
      bundle,
      bootstrapSpace,
      cosmosInterchainService,
      localchain,
      vowTools: vt,
    } = t.context;
    const { zoe } = bootstrapSpace;
    t.log('installing the contract...');
    const installation = await E(zoe).install(bundle);

    const privateArgs = harden({
      orchestrationService: cosmosInterchainService,
      storageNode: await bootstrapSpace.chainStorage,
      marshaller: await E(bootstrapSpace.board).getPublishingMarshaller(),
      timerService: await bootstrapSpace.chainTimerService,
      localchain,
      agoricNames: await bootstrapSpace.agoricNames,
    });

    const BLD = await bootstrapSpace.bldIssuerKit;

    t.log('starting the instance...');
    const { instance } = await E(zoe).startInstance(
      installation,
      { BLD: BLD.issuer },
      {},
      privateArgs,
    );
    const publicFacet = await E(zoe).getPublicFacet(instance);

    t.log('creating account invitation...');
    const toCreateAndFund = await E(publicFacet).makeCreateAndFundInvitation();

    const Deposit = AmountMath.make(BLD.brand, 1n);
    const payment = BLD.mint.mintPayment(Deposit);
    t.log('making offer...');
    const seat = await E(zoe).offer(
      toCreateAndFund,
      { give: { Deposit } },
      { Deposit: payment },
      { chainName },
    );

    const offerResult = await vt.when(E(seat).getOfferResult());
    t.log('offer result:', offerResult);
    t.truthy(offerResult, 'Offer result should exist');

    t.is(
      passStyleOf(offerResult.invitationMakers),
      'remotable',
      'Offer include invitationMakers',
    );
    t.like(offerResult, {
      publicSubscribers: {
        account: {
          description: 'Staking Account holder status',
          storagePath: 'mockChainStorageRoot.osmosislocalAccountAddress',
        },
      },
    });
  },
});

test(orchestrationAccountScenario, 'osmosis');
test(orchestrationAccountAndFundScenario, 'osmosis');

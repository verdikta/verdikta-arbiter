const { expect } = require("chai");
const fs   = require("fs");
const path = require("path");

describe("ArbiterOperator (live network)", () => {
  it("deploys", async () => {
    // ── 1. resolve LINK token address for the active network ──
    const { name: net } = network; // injected by Hardhat (e.g. "base_sepolia")

    const ADDRS = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "deployment-addresses.json"), "utf8")
    )[net];

    const LINK = ADDRS?.linkTokenAddress;
    if (!LINK) throw new Error(`No linkTokenAddress configured for network ${net}`);

    // ── 2. deploy ArbiterOperator pointing to that real LINK ──
    const ArbiterOperator = await ethers.getContractFactory("ArbiterOperator");
    const op = await ArbiterOperator.deploy(LINK);
    await op.waitForDeployment();       // ethers v6 helper

    // ── 3. simple assertion ──
    const [owner] = await ethers.getSigners();
    expect(await op.owner()).to.equal(owner.address);
  });
});


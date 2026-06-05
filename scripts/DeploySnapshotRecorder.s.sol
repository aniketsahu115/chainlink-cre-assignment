// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SnapshotRecorder} from "../contracts/SnapshotRecorder.sol";

contract DeploySnapshotRecorder is Script {
    address constant SEPOLIA_FORWARDER = 0x2eD413d5e63563F6ba5F9b4dEF2eA0AAE6f25e05;

    function run() external returns (SnapshotRecorder recorder) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        recorder = new SnapshotRecorder(SEPOLIA_FORWARDER);

        vm.stopBroadcast();

        console2.log("==============================================");
        console2.log("SnapshotRecorder deployed at:", address(recorder));
        console2.log("Forwarder address:           ", SEPOLIA_FORWARDER);
        console2.log("==============================================");
        console2.log("");
        console2.log("Next steps:");
        console2.log("1. Copy the deployed address above.");
        console2.log("2. Paste it in:");
        console2.log("   - .env  -> SNAPSHOT_RECORDER_ADDRESS");
        console2.log("   - workflows/snapshot-workflow/config.staging.json -> snapshotRecorderAddress");
        console2.log("3. Run the workflow simulation:");
        console2.log("   cre workflow simulate snapshot-workflow --target staging-settings \\");
        console2.log("     --http-payload workflows/snapshot-workflow/payload.json --broadcast");
    }
}
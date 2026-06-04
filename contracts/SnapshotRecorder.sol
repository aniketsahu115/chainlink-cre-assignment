// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract SnapshotRecorder is IReceiver, Ownable {
    struct Record {
        string token;
        uint256 price;
        uint256 blockNumber;
        uint256 timestamp;
    }

    address public immutable forwarder;

    uint256 public snapshotCount;

    Record public latestSnapshot;

    mapping(uint256 => Record) public snapshots;

    event SnapshotRecorded(
        uint256 indexed snapshotId,
        string indexed token,
        uint256 price,
        uint256 blockNumber,
        uint256 timestamp
    );

    error OnlyForwarder(address caller, address expected);
    error ZeroForwarderAddress();

    constructor(address _forwarder) Ownable(msg.sender) {
        if (_forwarder == address(0)) revert ZeroForwarderAddress();
        forwarder = _forwarder;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) {
            revert OnlyForwarder(msg.sender, forwarder);
        }

        Record memory rec = abi.decode(report, (Record));

        snapshotCount++;
        snapshots[snapshotCount] = rec;
        latestSnapshot = rec;

        emit SnapshotRecorded(
            snapshotCount,
            rec.token,
            rec.price,
            rec.blockNumber,
            rec.timestamp
        );
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function snapshot() external view returns (Record memory) {
        return latestSnapshot;
    }

    function getSnapshots(uint256 from, uint256 to)
        external
        view
        returns (Record[] memory out)
    {
        require(from >= 1 && to <= snapshotCount && from <= to, "bad range");

        out = new Record[](to - from + 1);

        for (uint256 i = from; i <= to; i++) {
            out[i - from] = snapshots[i];
        }
    }
}


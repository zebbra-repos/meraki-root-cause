import {
  compact,
  map,
  values,
  sortBy,
  find,
  includes,
  chain,
  pick,
  get,
  difference,
} from "lodash";
import { Graph } from "@dagrejs/graphlib";

import MerakiRootCause from "../../../types";

function extract(
  info: MerakiRootCause.ILldpCdpPortsMap,
): MerakiRootCause.INeighbor[] {
  const cdps = compact(map(values(info.ports), "cdp")).map(
    (port: MerakiRootCause.ICdp) => {
      return {
        ...port,
        portId: port.portId.replace(/^\D+/, ""),
        mac: port.deviceId.match(/.{2}/g).join(":"),
      };
    },
  );

  const lldps: MerakiRootCause.ILldp[] = compact(
    map(values(info.ports), "lldp"),
  );

  const neighbors: MerakiRootCause.INeighbor[] = sortBy(
    compact(
      lldps.map((lldp) => {
        const cdp = find(cdps, {
          sourcePort: lldp.sourcePort,
          portId: lldp.portId,
        });

        if (cdp) {
          return {
            ...lldp,
            ...cdp,
          };
        }

        return null;
      }),
    ),
    "sourcePort",
  );

  return neighbors;
}

function build(
  g: Graph,
  allDevices: MerakiRootCause.IDeviceSummary[],
  currentDevices: MerakiRootCause.IDeviceSummary[],
): Graph {
  const neighborDevices: MerakiRootCause.IDeviceSummary[] = [];
  const currentDevicesSerials = map(currentDevices, "serial");

  function isParentOf(
    src: MerakiRootCause.IDeviceSummary,
    dst: MerakiRootCause.IDeviceSummary,
  ) {
    return includes(g.successors(dst.serial) || [], src.serial);
  }

  function isOnSameLevel(neighbor: MerakiRootCause.IDeviceSummary) {
    return includes(currentDevicesSerials, neighbor.serial);
  }

  currentDevices.forEach((src: MerakiRootCause.IDeviceSummary) => {
    if (!g.hasNode(src.serial)) {
      g.setNode(src.serial, sanitizeNode(src));
    }

    chain(src.neighbors || [])
      .map((neighbor) => find(allDevices, { mac: neighbor.mac }))
      .compact()
      // discard neighbors for which the source node is a successor and it is not on the same level
      .filter(
        (neighbor) => !isParentOf(src, neighbor) || isOnSameLevel(neighbor),
      )
      .value()
      .forEach((neighbor) => {
        if (!g.hasNode(neighbor.serial)) {
          neighborDevices.push(neighbor);
          g.setNode(neighbor.serial, sanitizeNode(neighbor));
        }

        g.setEdge(src.serial, neighbor.serial, {});
      });
  });

  if (neighborDevices.length) {
    return build(g, allDevices, neighborDevices);
  }

  return g;
}

function sanitizeNode(node: any) {
  return pick(node, ["name", "serial", "mac", "status", "model"]);
}

function calcStatus(graph: Graph, degradedFirewallIds: string[]) {
  const nodes = graph.nodes().map((node) => graph.node(node));

  nodes.forEach((node) => {
    const isFirewall =
      node.model.startsWith("MX") || node.model.startsWith("vMX");

    const offlineParentSerials = compact(
      (graph.predecessors(node.serial) || []).map((serial) =>
        get(find(nodes, { serial, status: "offline" }), "serial"),
      ),
    );

    switch (node.status) {
      case "online":
        node.techStatus = "up";
        break;

      case "offline":
        if (isFirewall) {
          if (includes(degradedFirewallIds, node.serial)) {
            node.techStatus = "degraded";
          } else {
            node.techStatus = "down";
          }
        } else if (
          difference(offlineParentSerials, degradedFirewallIds).length
        ) {
          node.techStatus = "unknown";
        } else {
          node.techStatus = "down";
        }
        break;

      default:
        node.techStatus = "unknow";
        break;
    }
  });
}

export { extract, build, calcStatus };

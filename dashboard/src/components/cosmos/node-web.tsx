'use client';

// === JARVIS MOD #29 — Cosmos node-web (2026-07-06) ===
// A 3D web of glowing nodes grouped into clusters and connected by faint lines,
// rendered with additive blending so it reads as an energy lattice. Used twice:
//   1. distant background web (~100 nodes / ~8 clusters) drifting behind the orb
//   2. a sparse internal web inside the orb (child of the orb group, tumbles with it)
// Counts are prop-driven so low-perf mode can cut them hard.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { NODE_COLORS } from './palette';
// === JARVIS MOD #70: frozen scene clock ===
import { sceneTime } from './reduced-motion';
// === END JARVIS MOD #70 ===

interface WebGeometry {
  nodePositions: Float32Array;
  nodeColors: Float32Array;
  linePositions: Float32Array;
}

/**
 * Build clustered nodes in a spherical shell and connect near neighbours within
 * each cluster (plus a few inter-cluster bridges) into line segments.
 */
function buildWeb(
  nodeCount: number,
  clusters: number,
  radiusMin: number,
  radiusMax: number,
  linkDist: number,
  seed = 1,
): WebGeometry {
  // Deterministic PRNG so SSR/client and re-renders are stable.
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  // Cluster centers scattered through the shell.
  const centers: THREE.Vector3[] = [];
  for (let c = 0; c < clusters; c++) {
    const r = radiusMin + rand() * (radiusMax - radiusMin);
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    centers.push(
      new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      ),
    );
  }

  const nodes: THREE.Vector3[] = [];
  const cols: THREE.Color[] = [];
  const clusterOf: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const c = i % clusters;
    const spread = (radiusMax - radiusMin) * 0.28;
    const p = centers[c]
      .clone()
      .add(
        new THREE.Vector3(
          (rand() - 0.5) * spread * 2,
          (rand() - 0.5) * spread * 2,
          (rand() - 0.5) * spread * 2,
        ),
      );
    nodes.push(p);
    clusterOf.push(c);
    cols.push(new THREE.Color(NODE_COLORS[c % NODE_COLORS.length]));
  }

  const nodePositions = new Float32Array(nodeCount * 3);
  const nodeColors = new Float32Array(nodeCount * 3);
  for (let i = 0; i < nodeCount; i++) {
    nodePositions[i * 3] = nodes[i].x;
    nodePositions[i * 3 + 1] = nodes[i].y;
    nodePositions[i * 3 + 2] = nodes[i].z;
    nodeColors[i * 3] = cols[i].r;
    nodeColors[i * 3 + 1] = cols[i].g;
    nodeColors[i * 3 + 2] = cols[i].b;
  }

  // Links: connect nodes within linkDist (mostly intra-cluster because members
  // sit near each other). Cap per-node degree so it stays airy.
  const lineVerts: number[] = [];
  const degree = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    for (let j = i + 1; j < nodeCount; j++) {
      if (degree[i] >= 3 || degree[j] >= 3) continue;
      const d = nodes[i].distanceTo(nodes[j]);
      const sameCluster = clusterOf[i] === clusterOf[j];
      if (d < linkDist && (sameCluster || rand() < 0.15)) {
        lineVerts.push(
          nodes[i].x, nodes[i].y, nodes[i].z,
          nodes[j].x, nodes[j].y, nodes[j].z,
        );
        degree[i]++;
        degree[j]++;
      }
    }
  }

  return {
    nodePositions,
    nodeColors,
    linePositions: new Float32Array(lineVerts),
  };
}

interface NodeWebProps {
  nodeCount: number;
  clusters: number;
  radiusMin: number;
  radiusMax: number;
  linkDist: number;
  nodeSize?: number;
  nodeOpacity?: number;
  lineColor?: string;
  lineOpacity?: number;
  driftSpeed?: number; // radians/sec on Y
  seed?: number;
  pulse?: boolean; // subtle brightness pulse (background web)
}

export function NodeWeb({
  nodeCount,
  clusters,
  radiusMin,
  radiusMax,
  linkDist,
  nodeSize = 0.09,
  nodeOpacity = 0.85,
  lineColor = '#2dd4bf',
  lineOpacity = 0.18,
  driftSpeed = 0.02,
  seed = 1,
  pulse = false,
}: NodeWebProps) {
  const groupRef = useRef<THREE.Group>(null);
  const nodeMatRef = useRef<THREE.PointsMaterial>(null);

  const geo = useMemo(
    () => buildWeb(nodeCount, clusters, radiusMin, radiusMax, linkDist, seed),
    [nodeCount, clusters, radiusMin, radiusMax, linkDist, seed],
  );

  useFrame((state) => {
    const t = sceneTime(state.clock.elapsedTime); // MOD #70
    if (groupRef.current) {
      groupRef.current.rotation.y = t * driftSpeed;
      groupRef.current.rotation.x = Math.sin(t * driftSpeed * 0.5) * 0.08;
    }
    if (pulse && nodeMatRef.current) {
      nodeMatRef.current.opacity = nodeOpacity + Math.sin(t * 0.8) * 0.15;
    }
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[geo.nodePositions, 3]}
          />
          <bufferAttribute
            attach="attributes-color"
            args={[geo.nodeColors, 3]}
          />
        </bufferGeometry>
        <pointsMaterial
          ref={nodeMatRef}
          vertexColors
          size={nodeSize}
          sizeAttenuation
          transparent
          opacity={nodeOpacity}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {geo.linePositions.length > 0 && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[geo.linePositions, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial
            color={lineColor}
            transparent
            opacity={lineOpacity}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </lineSegments>
      )}
    </group>
  );
}
// === END JARVIS MOD #29 ===

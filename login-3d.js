/**
 * login-3d.js — High-Detail Procedural 3D Spacecraft & Orbital Station Engine
 * Inspired by Star Citizen & Foundation TV Series (Apple TV+)
 * Powered by Three.js for FGF Guild Management v3
 */

(function () {
    'use strict';

    let scene, camera, renderer;
    let stationGroup, outerRing, innerRing, centerCore, particles;
    let pointLight1, pointLight2, keyLight;
    let animationFrameId = null;
    let isRunning = false;

    // Space Battle Entities
    let ships = [];
    let aliens = [];
    let lasers = [];
    let explosions = [];
    let lastShotTime = 0;

    // Mouse tracking for 3D Parallax & Card Tilt
    let mouseX = 0, mouseY = 0;
    let targetMouseX = 0, targetMouseY = 0;
    let windowHalfX = window.innerWidth / 2;
    let windowHalfY = window.innerHeight / 2;

    function init3D() {
        const canvas = document.getElementById('login-3d-canvas');
        if (!canvas || typeof THREE === 'undefined') return;

        // 1. Scene setup
        scene = new THREE.Scene();

        // 2. Camera setup
        camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 24;

        // 3. Renderer setup
        renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            alpha: true,
            antialias: true,
            powerPreference: "high-performance"
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        // 4. Advanced Lighting (Directional Key Light + Accent Point Lights for Metallic Greebles)
        const ambientLight = new THREE.AmbientLight(0x121722, 1.6);
        scene.add(ambientLight);

        keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(15, 20, 15);
        scene.add(keyLight);

        // Lime accent light (#d2f872)
        pointLight1 = new THREE.PointLight(0xd2f872, 3.0, 70);
        pointLight1.position.set(16, 12, 14);
        scene.add(pointLight1);

        // Cyan accent light (#56c6f3)
        pointLight2 = new THREE.PointLight(0x56c6f3, 3.5, 70);
        pointLight2.position.set(-16, -14, 12);
        scene.add(pointLight2);

        // 5. Build High-Detail Concentric Orbital Ring Space Station (Reference Image 2)
        initOrbitalStation();

        // 6. Particle Starfield Background
        initStarfield();

        // 7. Initialize High-Detail Tactical Gunships & Alien Leviathans (Reference Images 1 & 3)
        initSpaceBattle();

        // 8. Event listeners
        window.addEventListener('resize', onWindowResize, false);
        window.addEventListener('mousemove', onMouseMove, false);

        initCardTilt();
        startLoop();
    }

    function initStarfield() {
        const particleCount = 1400;
        const particleGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        const colorLime = new THREE.Color(0xd2f872);
        const colorCyan = new THREE.Color(0x56c6f3);
        const colorWhite = new THREE.Color(0xffffff);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 90;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 90;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 70;

            let c = Math.random() > 0.5 ? colorLime : (Math.random() > 0.25 ? colorCyan : colorWhite);
            colors[i * 3] = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;
        }

        particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const particleMat = new THREE.PointsMaterial({
            size: 0.16,
            vertexColors: true,
            transparent: true,
            opacity: 0.65,
            blending: THREE.AdditiveBlending
        });

        particles = new THREE.Points(particleGeo, particleMat);
        scene.add(particles);
    }

    // ─── High-Detail Orbital Ring Space Station (Reference Image 2) ───
    function initOrbitalStation() {
        stationGroup = new THREE.Group();

        const metalMat = new THREE.MeshStandardMaterial({
            color: 0x222a38,
            metalness: 0.85,
            roughness: 0.35,
            flatShading: true
        });

        const darkMetalMat = new THREE.MeshStandardMaterial({
            color: 0x141924,
            metalness: 0.9,
            roughness: 0.2
        });

        const windowGlowMat = new THREE.MeshBasicMaterial({ color: 0x56c6f3 });
        const coreEnergyMat = new THREE.MeshPhongMaterial({
            color: 0xd2f872,
            emissive: 0x336600,
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.85
        });

        // 1. Main Outer Ring Structure
        const outerTorus = new THREE.TorusGeometry(8.2, 0.35, 12, 64);
        outerRing = new THREE.Mesh(outerTorus, metalMat);
        stationGroup.add(outerRing);

        // 16 Outer Docking & Habitat Module Blocks around the perimeter
        const moduleGeo = new THREE.BoxGeometry(0.7, 0.85, 1.2);
        const windowGeo = new THREE.BoxGeometry(0.72, 0.2, 0.8);

        for (let i = 0; i < 16; i++) {
            const angle = (i / 16) * Math.PI * 2;
            const module = new THREE.Mesh(moduleGeo, metalMat);
            const x = Math.cos(angle) * 8.2;
            const y = Math.sin(angle) * 8.2;

            module.position.set(x, y, 0);
            module.rotation.z = angle;

            // Small window lights
            const win = new THREE.Mesh(windowGeo, windowGlowMat);
            win.position.set(x, y, 0.1);
            win.rotation.z = angle;
            stationGroup.add(win);

            // Antenna towers protruding outwards
            if (i % 2 === 0) {
                const towerGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6);
                const tower = new THREE.Mesh(towerGeo, darkMetalMat);
                tower.position.set(Math.cos(angle) * 9.1, Math.sin(angle) * 9.1, 0);
                tower.rotation.z = angle + Math.PI / 2;
                stationGroup.add(tower);
            }

            stationGroup.add(module);
        }

        // 2. Inner Concentric Ring
        const innerTorus = new THREE.TorusGeometry(4.6, 0.28, 10, 48);
        innerRing = new THREE.Mesh(innerTorus, darkMetalMat);
        stationGroup.add(innerRing);

        // 8 Inner Module Blocks
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const mod = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.9), metalMat);
            mod.position.set(Math.cos(angle) * 4.6, Math.sin(angle) * 4.6, 0);
            mod.rotation.z = angle;
            stationGroup.add(mod);
        }

        // 3. Radial Spoke Struts connecting Hub to Inner and Outer Rings
        const spokeCount = 12;
        for (let i = 0; i < spokeCount; i++) {
            const angle = (i / spokeCount) * Math.PI * 2;
            const spokeGeo = new THREE.CylinderGeometry(0.07, 0.07, 8.2, 8);
            const spoke = new THREE.Mesh(spokeGeo, darkMetalMat);

            spoke.position.set(Math.cos(angle) * 4.1, Math.sin(angle) * 4.1, 0);
            spoke.rotation.z = angle + Math.PI / 2;
            stationGroup.add(spoke);
        }

        // 4. Central Energy Core Reactor & Spire Hub
        const hubGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.8, 16);
        const hub = new THREE.Mesh(hubGeo, metalMat);
        stationGroup.add(hub);

        const spireGeo = new THREE.CylinderGeometry(0.15, 0.45, 3.2, 12);
        centerCore = new THREE.Mesh(spireGeo, coreEnergyMat);
        stationGroup.add(centerCore);

        // Tilt station in 3D perspective
        stationGroup.rotation.x = Math.PI / 3;
        stationGroup.rotation.y = Math.PI / 8;

        scene.add(stationGroup);
    }

    // ─── High-Detail Procedural Tactical Gunships (Reference Images 1 & 3) ───
    function buildDetailedGunship(accentHex) {
        const ship = new THREE.Group();

        const hullMetal = new THREE.MeshStandardMaterial({
            color: 0x1a212e,
            metalness: 0.88,
            roughness: 0.3,
            flatShading: true
        });

        const darkArmor = new THREE.MeshStandardMaterial({
            color: 0x10141e,
            metalness: 0.92,
            roughness: 0.2
        });

        const glassMat = new THREE.MeshPhongMaterial({
            color: 0x112838,
            specular: 0x56c6f3,
            shininess: 100,
            transparent: true,
            opacity: 0.85
        });

        const thrusterGlowMat = new THREE.MeshBasicMaterial({ color: accentHex });

        // 1. Central Multi-Segment Fuselage Body
        const mainBodyGeo = new THREE.BoxGeometry(1.4, 0.85, 4.6);
        const mainBody = new THREE.Mesh(mainBodyGeo, hullMetal);
        ship.add(mainBody);

        // Upper Sloped Armor Spine
        const spineGeo = new THREE.BoxGeometry(1.15, 0.35, 3.6);
        spineGeo.rotateX(0.08);
        const spine = new THREE.Mesh(spineGeo, darkArmor);
        spine.position.set(0, 0.45, -0.2);
        ship.add(spine);

        // Ventral Cargo/Sensor Pod
        const bellyGeo = new THREE.BoxGeometry(0.95, 0.35, 2.2);
        const belly = new THREE.Mesh(bellyGeo, darkArmor);
        belly.position.set(0, -0.45, 0.2);
        ship.add(belly);

        // 2. Angular Cockpit Canopy (Images 1 & 3)
        const cockpitFrame = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.6, 1.2), darkArmor);
        cockpitFrame.position.set(0, 0.15, -2.4);
        ship.add(cockpitFrame);

        const cockpitGlass = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.48, 1.1), glassMat);
        cockpitGlass.position.set(0, 0.18, -2.45);
        ship.add(cockpitGlass);

        // Cockpit HUD glow light inside
        const hudLight = new THREE.PointLight(accentHex, 1.5, 4);
        hudLight.position.set(0, 0.2, -2.4);
        ship.add(hudLight);

        // 3. Heavy Twin Side Engine Nacelles & Air Intakes (Key feature from Image 1 & 3)
        const nacelleGeo = new THREE.BoxGeometry(0.75, 1.0, 3.4);
        const intakeFrameGeo = new THREE.BoxGeometry(0.68, 0.88, 0.35);
        const intakeGrillGeo = new THREE.BoxGeometry(0.62, 0.82, 0.1);
        const grillMat = new THREE.MeshBasicMaterial({ color: 0x080a0f });

        [-1.3, 1.3].forEach(xOffset => {
            // Main Nacelle Body
            const nacelle = new THREE.Mesh(nacelleGeo, hullMetal);
            nacelle.position.set(xOffset, 0.05, 0.2);
            ship.add(nacelle);

            // Front Air Intake Scoop Frame (Image 1 Intake)
            const intake = new THREE.Mesh(intakeFrameGeo, darkArmor);
            intake.position.set(xOffset, 0.05, -1.45);
            ship.add(intake);

            // Black Recessed Grill Blade
            const grill = new THREE.Mesh(intakeGrillGeo, grillMat);
            grill.position.set(xOffset, 0.05, -1.58);
            ship.add(grill);

            // Rear Exhaust Cylindrical Nozzles with Glowing Heat Rings
            const nozzleGeo = new THREE.CylinderGeometry(0.3, 0.35, 0.8, 14);
            nozzleGeo.rotateX(Math.PI / 2);
            const nozzle = new THREE.Mesh(nozzleGeo, darkArmor);
            nozzle.position.set(xOffset, 0.05, 2.1);
            ship.add(nozzle);

            // Thruster Glow Ring
            const ringGlow = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 8, 16), thrusterGlowMat);
            ringGlow.position.set(xOffset, 0.05, 2.45);
            ship.add(ringGlow);

            const engineLight = new THREE.PointLight(accentHex, 2.0, 6);
            engineLight.position.set(xOffset, 0.05, 2.5);
            ship.add(engineLight);
        });

        // 4. Dual Angled Vertical Tail Fins (Image 1 & 3)
        [-0.7, 0.7].forEach((xOffset, idx) => {
            const finGeo = new THREE.BoxGeometry(0.08, 0.95, 1.1);
            const fin = new THREE.Mesh(finGeo, darkArmor);
            fin.position.set(xOffset, 0.75, 1.9);
            fin.rotation.z = idx === 0 ? -0.22 : 0.22; // angled outwards
            fin.rotation.x = -0.15;
            ship.add(fin);

            // Navigation Light Tip
            const navLight = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), new THREE.MeshBasicMaterial({ color: idx === 0 ? 0xff0044 : 0x00ff88 }));
            navLight.position.set(xOffset * 1.1, 1.25, 2.2);
            ship.add(navLight);
        });

        // 5. Greebles & Turrets on Pont Deck
        const turretBaseGeo = new THREE.CylinderGeometry(0.22, 0.25, 0.15, 10);
        const barrelGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6);
        barrelGeo.rotateX(Math.PI / 2);

        const tBase = new THREE.Mesh(turretBaseGeo, darkArmor);
        tBase.position.set(0, 0.65, -0.8);
        const tBarrel1 = new THREE.Mesh(barrelGeo, darkArmor);
        tBarrel1.position.set(-0.08, 0.72, -1.0);
        const tBarrel2 = new THREE.Mesh(barrelGeo, darkArmor);
        tBarrel2.position.set(0.08, 0.72, -1.0);

        ship.add(tBase);
        ship.add(tBarrel1);
        ship.add(tBarrel2);

        ship.scale.set(0.7, 0.7, 0.7);
        return ship;
    }

    // ─── High-Detail Alien Leviathan / Void Entity ───
    function buildAlienEntity() {
        const alienGroup = new THREE.Group();

        // Biomechanical Core
        const coreGeo = new THREE.IcosahedronGeometry(1.35, 1);
        const coreMat = new THREE.MeshPhongMaterial({
            color: 0xff0055,
            emissive: 0xaa0033,
            emissiveIntensity: 0.9,
            specular: 0xff88bb,
            shininess: 90,
            flatShading: true
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        alienGroup.add(core);

        // Outer Dark Crystalline Armor Plates
        const plateGeo = new THREE.DodecahedronGeometry(1.8, 0);
        const plateMat = new THREE.MeshStandardMaterial({
            color: 0x120d18,
            wireframe: true,
            metalness: 0.9,
            roughness: 0.2
        });
        const plates = new THREE.Mesh(plateGeo, plateMat);
        alienGroup.add(plates);

        // Orbiting Defense Shards
        const shardGeo = new THREE.TetrahedronGeometry(0.45);
        const shardMat = new THREE.MeshStandardMaterial({ color: 0x1a1224, metalness: 0.95, roughness: 0.1 });

        for (let i = 0; i < 6; i++) {
            const shard = new THREE.Mesh(shardGeo, shardMat);
            const angle = (i / 6) * Math.PI * 2;
            shard.position.set(Math.cos(angle) * 2.2, Math.sin(angle) * 2.2, (Math.random() - 0.5) * 1.5);
            shard.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
            alienGroup.add(shard);
        }

        alienGroup.scale.set(0.8, 0.8, 0.8);
        return alienGroup;
    }

    function initSpaceBattle() {
        // Clear previous
        ships.forEach(s => scene.remove(s.mesh));
        aliens.forEach(a => scene.remove(a.mesh));
        ships = [];
        aliens = [];

        // Create 3 Tactical Gunships (Lime Green, Cyan, Lilac variants)
        const shipConfigs = [
            { color: 0xd2f872, speed: 0.0075, orbitR: 13.5, orbitY: 3.5, phase: 0 },
            { color: 0x56c6f3, speed: 0.006, orbitR: 16.0, orbitY: -4.5, phase: Math.PI * 0.66 },
            { color: 0xe4b5f0, speed: 0.007, orbitR: 14.5, orbitY: 1.0, phase: Math.PI * 1.33 }
        ];

        shipConfigs.forEach(cfg => {
            const mesh = buildDetailedGunship(cfg.color);
            scene.add(mesh);
            ships.push({
                mesh: mesh,
                color: cfg.color,
                orbitR: cfg.orbitR,
                orbitY: cfg.orbitY,
                speed: cfg.speed,
                phase: cfg.phase
            });
        });

        // Create 3 Alien Leviathans
        const alienConfigs = [
            { orbitR: 11, orbitY: 5.5, speed: 0.005, phase: Math.PI * 0.2 },
            { orbitR: 15, orbitY: -5.5, speed: 0.004, phase: Math.PI * 0.85 },
            { orbitR: 12.5, orbitY: -1.5, speed: 0.0055, phase: Math.PI * 1.55 }
        ];

        alienConfigs.forEach(cfg => {
            const mesh = buildAlienEntity();
            scene.add(mesh);
            aliens.push({
                mesh: mesh,
                orbitR: cfg.orbitR,
                orbitY: cfg.orbitY,
                speed: cfg.speed,
                phase: cfg.phase,
                recoil: 0
            });
        });
    }

    // ─── Laser Cannon & Explosion System ───
    function fireLaser(fromPos, toPos, colorHex) {
        const dir = new THREE.Vector3().subVectors(toPos, fromPos).normalize();
        const distance = fromPos.distanceTo(toPos);

        const laserGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);
        laserGeo.rotateX(Math.PI / 2);
        const laserMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95 });
        const laserMesh = new THREE.Mesh(laserGeo, laserMat);

        laserMesh.position.copy(fromPos);
        laserMesh.lookAt(toPos);

        scene.add(laserMesh);

        lasers.push({
            mesh: laserMesh,
            dir: dir,
            speed: 0.9,
            targetPos: toPos.clone(),
            life: 0,
            maxLife: Math.min(distance / 0.9, 45)
        });
    }

    function createExplosion(position, colorHex) {
        const particleCount = 20;
        const group = new THREE.Group();
        group.position.copy(position);

        const pGeo = new THREE.SphereGeometry(0.09, 6, 6);
        const pMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 1 });

        const pData = [];
        for (let i = 0; i < particleCount; i++) {
            const p = new THREE.Mesh(pGeo, pMat.clone());
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 0.45,
                (Math.random() - 0.5) * 0.45,
                (Math.random() - 0.5) * 0.45
            );
            group.add(p);
            pData.push({ mesh: p, vel: vel });
        }

        scene.add(group);
        explosions.push({ group: group, particles: pData, life: 0, maxLife: 22 });
    }

    function updateSpaceBattle(t) {
        // 1. Move Tactical Gunships
        ships.forEach(ship => {
            const angle = t * ship.speed + ship.phase;
            const targetX = Math.cos(angle) * ship.orbitR + mouseX * 1.8;
            const targetY = Math.sin(angle * 1.5) * 2.8 + ship.orbitY - mouseY * 1.8;
            const targetZ = Math.sin(angle) * (ship.orbitR * 0.35);

            const prevPos = ship.mesh.position.clone();
            ship.mesh.position.set(targetX, targetY, targetZ);

            // Orient ship towards movement vector
            const motionDir = new THREE.Vector3().subVectors(ship.mesh.position, prevPos);
            if (motionDir.lengthSq() > 0.0001) {
                const lookTarget = ship.mesh.position.clone().add(motionDir);
                ship.mesh.lookAt(lookTarget);
            }
        });

        // 2. Move Alien Leviathans
        aliens.forEach(alien => {
            const angle = -t * alien.speed + alien.phase;
            const targetX = Math.cos(angle) * alien.orbitR;
            const targetY = Math.sin(angle * 1.2) * 3.2 + alien.orbitY;
            const targetZ = Math.cos(angle * 1.5) * 4.5;

            alien.mesh.position.set(targetX, targetY, targetZ);
            alien.mesh.rotation.x += 0.01;
            alien.mesh.rotation.y += 0.015;

            if (alien.recoil > 0) {
                alien.mesh.position.x += (Math.random() - 0.5) * 0.25;
                alien.mesh.position.y += (Math.random() - 0.5) * 0.25;
                alien.recoil -= 0.1;
            }
        });

        // 3. Firing Lasers
        if (t - lastShotTime > 0.75 && ships.length > 0 && aliens.length > 0) {
            lastShotTime = t;
            const randomShip = ships[Math.floor(Math.random() * ships.length)];
            const randomAlien = aliens[Math.floor(Math.random() * aliens.length)];

            // Fire laser from gunship nose
            const nosePos = randomShip.mesh.position.clone().add(new THREE.Vector3(0, 0, -1.8));
            fireLaser(nosePos, randomAlien.mesh.position, randomShip.color);
        }

        // 4. Advance Lasers
        for (let i = lasers.length - 1; i >= 0; i--) {
            const l = lasers[i];
            l.mesh.position.addScaledVector(l.dir, l.speed);
            l.life++;

            let hit = false;
            aliens.forEach(alien => {
                if (!hit && l.mesh.position.distanceTo(alien.mesh.position) < 1.8) {
                    hit = true;
                    alien.recoil = 1.0;
                    createExplosion(l.mesh.position, 0xff0055);
                }
            });

            if (hit || l.life >= l.maxLife) {
                scene.remove(l.mesh);
                lasers.splice(i, 1);
            }
        }

        // 5. Advance Explosions
        for (let i = explosions.length - 1; i >= 0; i--) {
            const exp = explosions[i];
            exp.life++;
            const alpha = 1 - (exp.life / exp.maxLife);

            exp.particles.forEach(p => {
                p.mesh.position.add(p.vel);
                p.mesh.material.opacity = alpha;
            });

            if (exp.life >= exp.maxLife) {
                scene.remove(exp.group);
                explosions.splice(i, 1);
            }
        }
    }

    function onWindowResize() {
        windowHalfX = window.innerWidth / 2;
        windowHalfY = window.innerHeight / 2;
        if (!camera || !renderer) return;

        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    function onMouseMove(event) {
        targetMouseX = (event.clientX - windowHalfX) / windowHalfX;
        targetMouseY = (event.clientY - windowHalfY) / windowHalfY;
    }

    function animate(time) {
        if (!isRunning) return;

        // Smooth Lerp for Mouse Parallax
        mouseX += (targetMouseX - mouseX) * 0.05;
        mouseY += (targetMouseY - mouseY) * 0.05;

        const t = time * 0.001;

        // Rotate Concentric Orbital Station
        if (stationGroup) {
            stationGroup.rotation.z = t * 0.04; // Slow realistic axial rotation
            outerRing.rotation.z = -t * 0.02;
            innerRing.rotation.z = t * 0.03;

            if (centerCore) {
                const s = 1 + Math.sin(t * 2.5) * 0.06;
                centerCore.scale.set(s, s, s);
            }

            pointLight1.position.x = Math.sin(t * 0.7) * 16;
            pointLight1.position.z = Math.cos(t * 0.7) * 16;

            pointLight2.position.x = -Math.sin(t * 0.5) * 16;
            pointLight2.position.z = -Math.cos(t * 0.5) * 16;

            camera.position.x = mouseX * 3.0;
            camera.position.y = -mouseY * 3.0;
            camera.lookAt(scene.position);
        }

        if (particles) {
            particles.rotation.y = t * 0.04;
        }

        // Run Tactical Space Battle Simulation
        updateSpaceBattle(t);

        renderer.render(scene, camera);
        animationFrameId = requestAnimationFrame(animate);
    }

    function startLoop() {
        if (isRunning) return;
        isRunning = true;
        animationFrameId = requestAnimationFrame(animate);
    }

    function stopLoop() {
        isRunning = false;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    }

    // ─── 3D Card Tilt Controller ───
    function initCardTilt() {
        const wrappers = document.querySelectorAll('.gm-animated-card-wrap, .gm-login-card');
        wrappers.forEach(target => {
            target.addEventListener('mousemove', function (e) {
                const rect = target.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;

                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                const rotateX = ((y - centerY) / centerY) * -8;
                const rotateY = ((x - centerX) / centerX) * 8;

                target.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(1.01, 1.01, 1.01)`;

                target.style.setProperty('--shine-x', `${(x / rect.width * 100).toFixed(1)}%`);
                target.style.setProperty('--shine-y', `${(y / rect.height * 100).toFixed(1)}%`);
            });

            target.addEventListener('mouseleave', function () {
                target.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
                target.style.setProperty('--shine-x', '50%');
                target.style.setProperty('--shine-y', '50%');
            });
        });
    }

    function attachCanvasToActiveView() {
        const canvas = document.getElementById('login-3d-canvas');
        if (!canvas) return;

        const loginView = document.getElementById('login-view');
        const portalView = document.getElementById('player-portal-view');

        let targetView = null;
        if (loginView && !loginView.classList.contains('hidden')) {
            targetView = loginView;
        } else if (portalView && !portalView.classList.contains('hidden')) {
            targetView = portalView;
        }

        if (targetView && canvas.parentElement !== targetView) {
            targetView.insertBefore(canvas, targetView.firstChild);
            onWindowResize();
        }
    }

    // ─── Observe View Visiblity to pause GPU when logged in ───
    function setupVisibilityObserver() {
        const loginView = document.getElementById('login-view');
        const portalView = document.getElementById('player-portal-view');

        const handleVisibilityChange = () => {
            const isLoginActive = loginView && !loginView.classList.contains('hidden');
            const isPortalActive = portalView && !portalView.classList.contains('hidden');

            if (isLoginActive || isPortalActive) {
                attachCanvasToActiveView();
                startLoop();
            } else {
                stopLoop();
            }
        };

        const observer = new MutationObserver(handleVisibilityChange);

        if (loginView) observer.observe(loginView, { attributes: true, attributeFilter: ['class'] });
        if (portalView) observer.observe(portalView, { attributes: true, attributeFilter: ['class'] });

        handleVisibilityChange();
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init3D();
            setupVisibilityObserver();
        });
    } else {
        init3D();
        setupVisibilityObserver();
    }

    // Expose global controller
    window.RAD_LOGIN_3D = {
        init: init3D,
        start: startLoop,
        stop: stopLoop
    };
})();

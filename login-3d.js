/**
 * login-3d.js — Procedural Foundation 3D Space Battle & CSS 3D Card Tilt
 * Inspired by Foundation TV Series (Apple TV+) & FGF Guild Management DA
 * Powered by Three.js
 */

(function () {
    'use strict';

    let scene, camera, renderer;
    let coreGroup, innerCore, outerWireframe, ring1, ring2, particles;
    let pointLight1, pointLight2;
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
        camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 22;

        // 3. Renderer setup
        renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            alpha: true,
            antialias: true,
            powerPreference: "high-performance"
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        // 4. Lighting
        const ambientLight = new THREE.AmbientLight(0x151824, 1.4);
        scene.add(ambientLight);

        // Lime light (#d2f872)
        pointLight1 = new THREE.PointLight(0xd2f872, 2.8, 60);
        pointLight1.position.set(14, 12, 12);
        scene.add(pointLight1);

        // Cyan light (#56c6f3)
        pointLight2 = new THREE.PointLight(0x56c6f3, 3.2, 60);
        pointLight2.position.set(-14, -12, 10);
        scene.add(pointLight2);

        // 5. Central 3D Core Group (Holographic Relic / Warp Gate)
        coreGroup = new THREE.Group();

        // Inner Energy Core
        const innerGeo = new THREE.IcosahedronGeometry(2.5, 1);
        const innerMat = new THREE.MeshPhongMaterial({
            color: 0xd2f872,
            emissive: 0x224408,
            specular: 0xffffff,
            shininess: 90,
            transparent: true,
            opacity: 0.7,
            flatShading: true
        });
        innerCore = new THREE.Mesh(innerGeo, innerMat);
        coreGroup.add(innerCore);

        // Outer Wireframe Shield
        const outerGeo = new THREE.IcosahedronGeometry(4.0, 2);
        const outerMat = new THREE.MeshStandardMaterial({
            color: 0x56c6f3,
            wireframe: true,
            transparent: true,
            opacity: 0.3,
            roughness: 0.3,
            metalness: 0.8
        });
        outerWireframe = new THREE.Mesh(outerGeo, outerMat);
        coreGroup.add(outerWireframe);

        // Orbiting Rings
        const ringGeo1 = new THREE.TorusGeometry(5.2, 0.05, 16, 100);
        const ringMat1 = new THREE.MeshBasicMaterial({ color: 0x56c6f3, wireframe: true, transparent: true, opacity: 0.4 });
        ring1 = new THREE.Mesh(ringGeo1, ringMat1);
        ring1.rotation.x = Math.PI / 3;
        coreGroup.add(ring1);

        const ringGeo2 = new THREE.TorusGeometry(6.4, 0.04, 16, 100);
        const ringMat2 = new THREE.MeshBasicMaterial({ color: 0xd2f872, wireframe: true, transparent: true, opacity: 0.35 });
        ring2 = new THREE.Mesh(ringGeo2, ringMat2);
        ring2.rotation.x = -Math.PI / 4;
        coreGroup.add(ring2);

        scene.add(coreGroup);

        // 6. Particle Starfield
        initStarfield();

        // 7. Initialize Foundation Fleet & Alien Targets
        initSpaceBattle();

        // 8. Event listeners
        window.addEventListener('resize', onWindowResize, false);
        window.addEventListener('mousemove', onMouseMove, false);

        initCardTilt();
        startLoop();
    }

    function initStarfield() {
        const particleCount = 1200;
        const particleGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        const colorLime = new THREE.Color(0xd2f872);
        const colorCyan = new THREE.Color(0x56c6f3);
        const colorWhite = new THREE.Color(0xffffff);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 60;

            let c = Math.random() > 0.5 ? colorLime : (Math.random() > 0.25 ? colorCyan : colorWhite);
            colors[i * 3] = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;
        }

        particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const particleMat = new THREE.PointsMaterial({
            size: 0.18,
            vertexColors: true,
            transparent: true,
            opacity: 0.65,
            blending: THREE.AdditiveBlending
        });

        particles = new THREE.Points(particleGeo, particleMat);
        scene.add(particles);
    }

    // ─── Procedural Foundation Fleet & Alien Entities Construction ───
    function createFoundationShip(colorHex) {
        const shipGroup = new THREE.Group();

        // Fuselage (Sleek elongated cone/cylinder)
        const bodyGeo = new THREE.ConeGeometry(0.55, 3.2, 5);
        bodyGeo.rotateX(Math.PI / 2);
        const bodyMat = new THREE.MeshPhongMaterial({
            color: 0x121722,
            specular: colorHex,
            shininess: 80,
            flatShading: true
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        shipGroup.add(body);

        // Wing Fins
        const wingGeo = new THREE.BoxGeometry(2.4, 0.06, 0.9);
        const wingMat = new THREE.MeshStandardMaterial({ color: 0x1a2232, metalness: 0.8, roughness: 0.2 });
        const wings = new THREE.Mesh(wingGeo, wingMat);
        wings.position.set(0, 0, 0.2);
        shipGroup.add(wings);

        // Glowing Canopy
        const canopyGeo = new THREE.SphereGeometry(0.28, 8, 8);
        const canopyMat = new THREE.MeshPhongMaterial({
            color: colorHex,
            emissive: colorHex,
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.95
        });
        const canopy = new THREE.Mesh(canopyGeo, canopyMat);
        canopy.position.set(0, 0.2, -0.4);
        shipGroup.add(canopy);

        // Engine Thruster Light
        const thrusterGeo = new THREE.SphereGeometry(0.32, 12, 12);
        const thrusterMat = new THREE.MeshBasicMaterial({ color: colorHex });
        const thruster = new THREE.Mesh(thrusterGeo, thrusterMat);
        thruster.position.set(0, 0, 1.6);
        shipGroup.add(thruster);

        const thrusterLight = new THREE.PointLight(colorHex, 2, 8);
        thrusterLight.position.set(0, 0, 1.8);
        shipGroup.add(thrusterLight);

        shipGroup.scale.set(0.65, 0.65, 0.65);
        return shipGroup;
    }

    function createAlienEntity() {
        const alienGroup = new THREE.Group();

        // Biomechanical Core
        const coreGeo = new THREE.DodecahedronGeometry(1.2, 0);
        const coreMat = new THREE.MeshPhongMaterial({
            color: 0xff0055,
            emissive: 0x880022,
            emissiveIntensity: 0.9,
            specular: 0xffaae5,
            shininess: 100,
            flatShading: true
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        alienGroup.add(core);

        // Outer Dark Shards
        const shardGeo = new THREE.TetrahedronGeometry(0.5);
        const shardMat = new THREE.MeshStandardMaterial({ color: 0x15121e, metalness: 0.9, roughness: 0.1 });

        for (let i = 0; i < 5; i++) {
            const shard = new THREE.Mesh(shardGeo, shardMat);
            const angle = (i / 5) * Math.PI * 2;
            shard.position.set(Math.cos(angle) * 1.8, Math.sin(angle) * 1.8, (Math.random() - 0.5) * 1.2);
            shard.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
            alienGroup.add(shard);
        }

        alienGroup.scale.set(0.75, 0.75, 0.75);
        return alienGroup;
    }

    function initSpaceBattle() {
        // Clear previous
        ships.forEach(s => scene.remove(s.mesh));
        aliens.forEach(a => scene.remove(a.mesh));
        ships = [];
        aliens = [];

        // 1. Create 3 Foundation Ships (Lime Green & Cyan variants)
        const shipConfigs = [
            { color: 0xd2f872, speed: 0.008, orbitR: 12, orbitY: 3, phase: 0 },
            { color: 0x56c6f3, speed: 0.006, orbitR: 15, orbitY: -4, phase: Math.PI * 0.66 },
            { color: 0xe4b5f0, speed: 0.007, orbitR: 13.5, orbitY: 1, phase: Math.PI * 1.33 }
        ];

        shipConfigs.forEach(cfg => {
            const mesh = createFoundationShip(cfg.color);
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

        // 2. Create 3 Alien Hostile Entities
        const alienConfigs = [
            { orbitR: 10, orbitY: 5, speed: 0.005, phase: Math.PI * 0.25 },
            { orbitR: 14, orbitY: -5, speed: 0.004, phase: Math.PI * 0.9 },
            { orbitR: 11.5, orbitY: -1, speed: 0.006, phase: Math.PI * 1.6 }
        ];

        alienConfigs.forEach(cfg => {
            const mesh = createAlienEntity();
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

        const laserGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6);
        laserGeo.rotateX(Math.PI / 2);
        const laserMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95 });
        const laserMesh = new THREE.Mesh(laserGeo, laserMat);

        laserMesh.position.copy(fromPos);
        laserMesh.lookAt(toPos);

        scene.add(laserMesh);

        lasers.push({
            mesh: laserMesh,
            dir: dir,
            speed: 0.85,
            targetPos: toPos.clone(),
            life: 0,
            maxLife: Math.min(distance / 0.85, 40)
        });
    }

    function createExplosion(position, colorHex) {
        const particleCount = 18;
        const group = new THREE.Group();
        group.position.copy(position);

        const pGeo = new THREE.SphereGeometry(0.08, 6, 6);
        const pMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 1 });

        const pData = [];
        for (let i = 0; i < particleCount; i++) {
            const p = new THREE.Mesh(pGeo, pMat.clone());
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4
            );
            group.add(p);
            pData.push({ mesh: p, vel: vel });
        }

        scene.add(group);
        explosions.push({ group: group, particles: pData, life: 0, maxLife: 20 });
    }

    function updateSpaceBattle(t) {
        // 1. Move Foundation Ships
        ships.forEach((ship, index) => {
            const angle = t * ship.speed + ship.phase;
            const targetX = Math.cos(angle) * ship.orbitR + mouseX * 1.5;
            const targetY = Math.sin(angle * 1.5) * 2.5 + ship.orbitY - mouseY * 1.5;
            const targetZ = Math.sin(angle) * (ship.orbitR * 0.4);

            const prevPos = ship.mesh.position.clone();
            ship.mesh.position.set(targetX, targetY, targetZ);

            // Orient ship towards direction of motion
            const motionDir = new THREE.Vector3().subVectors(ship.mesh.position, prevPos);
            if (motionDir.lengthSq() > 0.0001) {
                const lookTarget = ship.mesh.position.clone().add(motionDir);
                ship.mesh.lookAt(lookTarget);
            }
        });

        // 2. Move Alien Entities
        aliens.forEach((alien, index) => {
            const angle = -t * alien.speed + alien.phase;
            const targetX = Math.cos(angle) * alien.orbitR;
            const targetY = Math.sin(angle * 1.2) * 3 + alien.orbitY;
            const targetZ = Math.cos(angle * 1.5) * 4;

            alien.mesh.position.set(targetX, targetY, targetZ);
            alien.mesh.rotation.x += 0.01;
            alien.mesh.rotation.y += 0.015;

            // Recoil shake effect when hit
            if (alien.recoil > 0) {
                alien.mesh.position.x += (Math.random() - 0.5) * 0.2;
                alien.mesh.position.y += (Math.random() - 0.5) * 0.2;
                alien.recoil -= 0.1;
            }
        });

        // 3. Auto Firing Cannons (every ~0.8s)
        if (t - lastShotTime > 0.8 && ships.length > 0 && aliens.length > 0) {
            lastShotTime = t;
            const randomShip = ships[Math.floor(Math.random() * ships.length)];
            const randomAlien = aliens[Math.floor(Math.random() * aliens.length)];

            fireLaser(randomShip.mesh.position, randomAlien.mesh.position, randomShip.color);
        }

        // 4. Advance Lasers
        for (let i = lasers.length - 1; i >= 0; i--) {
            const l = lasers[i];
            l.mesh.position.addScaledVector(l.dir, l.speed);
            l.life++;

            // Check collision with targets
            let hit = false;
            aliens.forEach(alien => {
                if (!hit && l.mesh.position.distanceTo(alien.mesh.position) < 1.6) {
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

        // Rotate Holographic Central Gate
        if (coreGroup) {
            innerCore.rotation.x = t * 0.4;
            innerCore.rotation.y = t * 0.6;

            outerWireframe.rotation.x = -t * 0.2;
            outerWireframe.rotation.y = -t * 0.35;

            ring1.rotation.z = t * 0.3;
            ring2.rotation.y = -t * 0.25;

            const scale = 1 + Math.sin(t * 2) * 0.05;
            innerCore.scale.set(scale, scale, scale);

            pointLight1.position.x = Math.sin(t * 0.8) * 15;
            pointLight1.position.z = Math.cos(t * 0.8) * 15;

            pointLight2.position.x = -Math.sin(t * 0.6) * 15;
            pointLight2.position.z = -Math.cos(t * 0.6) * 15;

            camera.position.x = mouseX * 2.5;
            camera.position.y = -mouseY * 2.5;
            camera.lookAt(scene.position);
        }

        if (particles) {
            particles.rotation.y = t * 0.05;
        }

        // Run Space Battle Animation & Laser Combat
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

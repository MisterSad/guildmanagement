/**
 * login-3d.js — Ultra-Realistic Procedural 3D Space Battle & Shader Engine
 * Inspired by Star Citizen & Foundation TV Series (Apple TV+)
 * Features: Procedural Hull Bump Maps, Panel Seams, Engine Plasma Trails, Muzzle Flashes, Shield Bubbles, Nebulae & PBR Lighting
 * Powered by Three.js for FGF Guild Management v3
 */

(function () {
    'use strict';

    let scene, camera, renderer;
    let stationGroup, outerRing, innerRing, centerCore, particles, nebulaGroup;
    let pointLight1, pointLight2, keyLight, sunLight;
    let hullBumpTexture, hullRoughnessTexture;
    let animationFrameId = null;
    let isRunning = false;

    // Entities & Systems
    let ships = [];
    let aliens = [];
    let lasers = [];
    let explosions = [];
    let engineTrails = [];
    let muzzleFlashes = [];
    let lastShotTime = 0;

    // Mouse tracking for 3D Parallax & Card Tilt
    let mouseX = 0, mouseY = 0;
    let targetMouseX = 0, targetMouseY = 0;
    let windowHalfX = window.innerWidth / 2;
    let windowHalfY = window.innerHeight / 2;

    function createEnvironmentMap() {
        const envCanvas = document.createElement('canvas');
        envCanvas.width = 512;
        envCanvas.height = 256;
        const ctx = envCanvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#050a10');
        grad.addColorStop(0.5, '#1a2b42');
        grad.addColorStop(1, '#050a10');
        ctx.fillStyle = grad;
        ctx.fillRect(0,0,512,256);
        
        ctx.fillStyle = '#ffffff';
        ctx.filter = 'blur(3px)';
        for(let i=0; i<30; i++) {
            ctx.beginPath();
            ctx.arc(Math.random()*512, Math.random()*256, Math.random()*5 + 1, 0, Math.PI*2);
            ctx.fill();
        }
        
        const envTex = new THREE.CanvasTexture(envCanvas);
        envTex.mapping = THREE.EquirectangularReflectionMapping;
        return envTex;
    }

    function init3D() {
        const canvas = document.getElementById('login-3d-canvas');
        if (!canvas || typeof THREE === 'undefined') return;

        // 1. Scene setup
        scene = new THREE.Scene();

        // 2. Camera setup
        camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 25;

        // 3. Renderer setup with PBR rendering
        renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            alpha: true,
            antialias: true,
            powerPreference: "high-performance"
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.25;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        pmremGenerator.compileEquirectangularShader();
        scene.environment = pmremGenerator.fromEquirectangular(createEnvironmentMap()).texture;

        // 4. Create Procedural Texture Maps for Realistic Metallic Panels & Rivets
        createProceduralHullTextures();

        // 5. Deep Space High-Contrast Lighting Setup
        initSpaceLighting();

        // 6. Deep Cosmic Nebula Cloud Background
        initCosmicNebula();

        // 7. Particle Starfield
        initStarfield();

        // 8. Build High-Detail Concentric Orbital Ring Space Station (Reference Image 2)
        initOrbitalStation();

        // 9. Initialize High-Detail Tactical Gunships & Alien Leviathans
        initSpaceBattle();

        // 10. Event listeners
        window.addEventListener('resize', onWindowResize, false);
        window.addEventListener('mousemove', onMouseMove, false);

        initCardTilt();
        startLoop();
    }

    // ─── Procedural Canvas Texture Generator for Armor Panel Seams & Rivets ───
    function createProceduralHullTextures() {
        const cvs = document.createElement('canvas');
        cvs.width = 1024;
        cvs.height = 1024;
        const ctx = cvs.getContext('2d');

        ctx.fillStyle = '#7a7a7a';
        ctx.fillRect(0, 0, 1024, 1024);

        const imgData = ctx.getImageData(0,0,1024,1024);
        for(let i=0; i<imgData.data.length; i+=4) {
            const noise = (Math.random() - 0.5) * 16;
            imgData.data[i] = Math.min(255, Math.max(0, imgData.data[i] + noise));
            imgData.data[i+1] = Math.min(255, Math.max(0, imgData.data[i+1] + noise));
            imgData.data[i+2] = Math.min(255, Math.max(0, imgData.data[i+2] + noise));
        }
        ctx.putImageData(imgData, 0, 0);

        ctx.strokeStyle = 'rgba(15,15,15, 0.9)';
        const step = 128;
        for (let x = 0; x < 1024; x += step) {
            ctx.beginPath();
            ctx.lineWidth = (x % (step*2) === 0) ? 6 : 3;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 1024);
            ctx.stroke();
        }
        for (let y = 0; y < 1024; y += step) {
            ctx.beginPath();
            ctx.lineWidth = (y % (step*2) === 0) ? 6 : 3;
            ctx.moveTo(0, y);
            ctx.lineTo(1024, y);
            ctx.stroke();
        }

        ctx.fillStyle = '#e5e5e5';
        for (let x = step/2; x < 1024; x += step) {
            for (let y = step/2; y < 1024; y += step) {
                ctx.beginPath(); ctx.arc(x - 24, y - 24, 3, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc(x + 24, y - 24, 3, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc(x - 24, y + 24, 3, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc(x + 24, y + 24, 3, 0, Math.PI * 2); ctx.fill();
            }
        }

        ctx.fillStyle = 'rgba(20,20,20,0.35)';
        for (let i = 0; i < 2500; i++) {
            const rx = Math.random() * 1024;
            const ry = Math.random() * 1024;
            ctx.fillRect(rx, ry, Math.random() * 20 + 2, Math.random() * 2 + 1);
        }

        hullBumpTexture = new THREE.CanvasTexture(cvs);
        hullBumpTexture.wrapS = THREE.RepeatWrapping;
        hullBumpTexture.wrapT = THREE.RepeatWrapping;
        hullBumpTexture.repeat.set(2, 2);

        hullRoughnessTexture = hullBumpTexture.clone();
    }

    function initSpaceLighting() {
        const ambientLight = new THREE.AmbientLight(0x101522, 1.8);
        scene.add(ambientLight);

        // Key Sun Light (Deep Space High-Contrast Key)
        sunLight = new THREE.DirectionalLight(0xfff5ea, 3.2);
        sunLight.position.set(20, 25, 18);
        sunLight.castShadow = true;
        sunLight.shadow.mapSize.width = 2048;
        sunLight.shadow.mapSize.height = 2048;
        sunLight.shadow.camera.near = 0.5;
        sunLight.shadow.camera.far = 100;
        sunLight.shadow.camera.left = -25;
        sunLight.shadow.camera.right = 25;
        sunLight.shadow.camera.top = 25;
        sunLight.shadow.camera.bottom = -25;
        sunLight.shadow.bias = -0.001;
        scene.add(sunLight);

        // Lime Rim Light (#d2f872)
        pointLight1 = new THREE.PointLight(0xd2f872, 3.5, 75);
        pointLight1.position.set(18, 14, 16);
        pointLight1.castShadow = true;
        pointLight1.shadow.bias = -0.002;
        scene.add(pointLight1);

        // Cyan Rim Light (#56c6f3)
        pointLight2 = new THREE.PointLight(0x56c6f3, 4.0, 75);
        pointLight2.position.set(-18, -16, 14);
        pointLight2.castShadow = true;
        pointLight2.shadow.bias = -0.002;
        scene.add(pointLight2);
    }

    function initCosmicNebula() {
        nebulaGroup = new THREE.Group();

        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
        grad.addColorStop(0, 'rgba(86, 198, 243, 0.25)');
        grad.addColorStop(0.5, 'rgba(210, 248, 114, 0.12)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending });

        for (let i = 0; i < 6; i++) {
            const sprite = new THREE.Sprite(mat);
            sprite.scale.set(45, 45, 1);
            sprite.position.set((Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, -30 - Math.random() * 20);
            nebulaGroup.add(sprite);
        }

        scene.add(nebulaGroup);
    }

    function initStarfield() {
        const particleCount = 1500;
        const particleGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        const colorLime = new THREE.Color(0xd2f872);
        const colorCyan = new THREE.Color(0x56c6f3);
        const colorWhite = new THREE.Color(0xffffff);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 100;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 100;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 80;

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
            opacity: 0.7,
            blending: THREE.AdditiveBlending
        });

        particles = new THREE.Points(particleGeo, particleMat);
        scene.add(particles);
    }

    // ─── High-Detail Orbital Ring Space Station (Reference Image 2) ───
    function initOrbitalStation() {
        stationGroup = new THREE.Group();

        const metalMat = new THREE.MeshStandardMaterial({
            color: 0x222b3b,
            bumpMap: hullBumpTexture,
            bumpScale: 0.06,
            metalness: 0.88,
            roughness: 0.3,
            flatShading: true
        });

        const darkMetalMat = new THREE.MeshStandardMaterial({
            color: 0x121724,
            bumpMap: hullBumpTexture,
            bumpScale: 0.04,
            metalness: 0.92,
            roughness: 0.2
        });

        const windowGlowMat = new THREE.MeshBasicMaterial({ color: 0x56c6f3 });
        const coreEnergyMat = new THREE.MeshPhongMaterial({
            color: 0xd2f872,
            emissive: 0x336600,
            emissiveIntensity: 0.85,
            transparent: true,
            opacity: 0.85
        });

        // 1. Main Outer Ring Structure
        const outerTorus = new THREE.TorusGeometry(8.5, 0.38, 14, 64);
        outerRing = new THREE.Mesh(outerTorus, metalMat);
        stationGroup.add(outerRing);

        // 16 Outer Docking & Habitat Module Blocks around the perimeter
        const moduleGeo = new THREE.BoxGeometry(0.75, 0.9, 1.25);
        const windowGeo = new THREE.BoxGeometry(0.78, 0.22, 0.85);

        for (let i = 0; i < 16; i++) {
            const angle = (i / 16) * Math.PI * 2;
            const module = new THREE.Mesh(moduleGeo, metalMat);
            const x = Math.cos(angle) * 8.5;
            const y = Math.sin(angle) * 8.5;

            module.position.set(x, y, 0);
            module.rotation.z = angle;

            const win = new THREE.Mesh(windowGeo, windowGlowMat);
            win.position.set(x, y, 0.1);
            win.rotation.z = angle;
            stationGroup.add(win);

            if (i % 2 === 0) {
                const towerGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6);
                const tower = new THREE.Mesh(towerGeo, darkMetalMat);
                tower.position.set(Math.cos(angle) * 9.4, Math.sin(angle) * 9.4, 0);
                tower.rotation.z = angle + Math.PI / 2;
                stationGroup.add(tower);
            }

            stationGroup.add(module);
        }

        // 2. Inner Concentric Ring
        const innerTorus = new THREE.TorusGeometry(4.8, 0.3, 10, 48);
        innerRing = new THREE.Mesh(innerTorus, darkMetalMat);
        stationGroup.add(innerRing);

        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const mod = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.65, 0.95), metalMat);
            mod.position.set(Math.cos(angle) * 4.8, Math.sin(angle) * 4.8, 0);
            mod.rotation.z = angle;
            stationGroup.add(mod);
        }

        // 3. Radial Spoke Struts
        const spokeCount = 12;
        for (let i = 0; i < spokeCount; i++) {
            const angle = (i / spokeCount) * Math.PI * 2;
            const spokeGeo = new THREE.CylinderGeometry(0.07, 0.07, 8.5, 8);
            const spoke = new THREE.Mesh(spokeGeo, darkMetalMat);

            spoke.position.set(Math.cos(angle) * 4.25, Math.sin(angle) * 4.25, 0);
            spoke.rotation.z = angle + Math.PI / 2;
            stationGroup.add(spoke);
        }

        // 4. Central Energy Core Reactor
        const hubGeo = new THREE.CylinderGeometry(1.3, 1.3, 0.85, 16);
        const hub = new THREE.Mesh(hubGeo, metalMat);
        stationGroup.add(hub);

        const spireGeo = new THREE.CylinderGeometry(0.15, 0.48, 3.5, 12);
        centerCore = new THREE.Mesh(spireGeo, coreEnergyMat);
        stationGroup.add(centerCore);

        stationGroup.rotation.x = Math.PI / 3;
        stationGroup.rotation.y = Math.PI / 8;

        stationGroup.traverse(child => {
            if (child.isMesh && child.material.type !== 'MeshBasicMaterial' && child.material.type !== 'MeshPhongMaterial') {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        scene.add(stationGroup);
    }

    // ─── High-Detail Procedural Tactical Gunships with Bump Maps & Shield Shell ───
    function buildDetailedGunship(accentHex) {
        const ship = new THREE.Group();

        const hullMetal = new THREE.MeshStandardMaterial({
            color: 0x1c2432,
            bumpMap: hullBumpTexture,
            bumpScale: 0.08,
            metalness: 0.88,
            roughness: 0.35,
            flatShading: true
        });

        const darkArmor = new THREE.MeshStandardMaterial({
            color: 0x101522,
            bumpMap: hullBumpTexture,
            bumpScale: 0.05,
            metalness: 0.94,
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
        const mainBodyGeo = new THREE.BoxGeometry(1.45, 0.9, 4.8);
        const mainBody = new THREE.Mesh(mainBodyGeo, hullMetal);
        ship.add(mainBody);

        // Upper Sloped Armor Spine
        const spineGeo = new THREE.BoxGeometry(1.2, 0.38, 3.8);
        spineGeo.rotateX(0.08);
        const spine = new THREE.Mesh(spineGeo, darkArmor);
        spine.position.set(0, 0.48, -0.2);
        ship.add(spine);

        // Ventral Cargo/Sensor Pod
        const bellyGeo = new THREE.BoxGeometry(0.98, 0.38, 2.4);
        const belly = new THREE.Mesh(bellyGeo, darkArmor);
        belly.position.set(0, -0.48, 0.2);
        ship.add(belly);

        // 2. Angular Cockpit Canopy (Reference Images 1 & 3)
        const cockpitFrame = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.62, 1.25), darkArmor);
        cockpitFrame.position.set(0, 0.16, -2.5);
        ship.add(cockpitFrame);

        const cockpitGlass = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 1.15), glassMat);
        cockpitGlass.position.set(0, 0.2, -2.55);
        ship.add(cockpitGlass);

        const hudLight = new THREE.PointLight(accentHex, 1.5, 4);
        hudLight.position.set(0, 0.2, -2.5);
        ship.add(hudLight);

        // 3. Heavy Twin Side Engine Nacelles & Air Intakes (Reference Images 1 & 3)
        const nacelleGeo = new THREE.BoxGeometry(0.78, 1.05, 3.6);
        const intakeFrameGeo = new THREE.BoxGeometry(0.72, 0.92, 0.38);
        const intakeGrillGeo = new THREE.BoxGeometry(0.66, 0.85, 0.1);
        const grillMat = new THREE.MeshBasicMaterial({ color: 0x080a0f });

        const thrusterNozzlePositions = [];

        [-1.35, 1.35].forEach(xOffset => {
            const nacelle = new THREE.Mesh(nacelleGeo, hullMetal);
            nacelle.position.set(xOffset, 0.05, 0.2);
            ship.add(nacelle);

            const intake = new THREE.Mesh(intakeFrameGeo, darkArmor);
            intake.position.set(xOffset, 0.05, -1.55);
            ship.add(intake);

            const grill = new THREE.Mesh(intakeGrillGeo, grillMat);
            grill.position.set(xOffset, 0.05, -1.68);
            ship.add(grill);

            const nozzleGeo = new THREE.CylinderGeometry(0.32, 0.4, 0.85, 14);
            nozzleGeo.rotateX(Math.PI / 2);
            const nozzle = new THREE.Mesh(nozzleGeo, darkArmor);
            nozzle.position.set(xOffset, 0.05, 2.2);
            ship.add(nozzle);

            const ringGlow = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 8, 16), thrusterGlowMat);
            ringGlow.position.set(xOffset, 0.05, 2.55);
            ship.add(ringGlow);

            const engineLight = new THREE.PointLight(accentHex, 2.2, 7);
            engineLight.position.set(xOffset, 0.05, 2.6);
            ship.add(engineLight);

            thrusterNozzlePositions.push(new THREE.Vector3(xOffset, 0.05, 2.6));
        });

        // 4. Dual Angled Vertical Tail Fins
        [-0.72, 0.72].forEach((xOffset, idx) => {
            const finGeo = new THREE.BoxGeometry(0.08, 1.0, 1.15);
            const fin = new THREE.Mesh(finGeo, darkArmor);
            fin.position.set(xOffset, 0.78, 2.0);
            fin.rotation.z = idx === 0 ? -0.22 : 0.22;
            fin.rotation.x = -0.15;
            ship.add(fin);

            const navLight = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), new THREE.MeshBasicMaterial({ color: idx === 0 ? 0xff0044 : 0x00ff88 }));
            navLight.position.set(xOffset * 1.1, 1.3, 2.3);
            ship.add(navLight);
        });

        // 5. Deck Turrets & Cannon Barrels
        const turretBaseGeo = new THREE.CylinderGeometry(0.24, 0.28, 0.16, 10);
        const barrelGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6);
        barrelGeo.rotateX(Math.PI / 2);

        const tBase = new THREE.Mesh(turretBaseGeo, darkArmor);
        tBase.position.set(0, 0.68, -0.85);
        const tBarrel1 = new THREE.Mesh(barrelGeo, darkArmor);
        tBarrel1.position.set(-0.09, 0.75, -1.05);
        const tBarrel2 = new THREE.Mesh(barrelGeo, darkArmor);
        tBarrel2.position.set(0.09, 0.75, -1.05);

        ship.add(tBase);
        ship.add(tBarrel1);
        ship.add(tBarrel2);

        // 6. Holographic Shield Hex Shell
        const shieldGeo = new THREE.IcosahedronGeometry(3.2, 1);
        const shieldMat = new THREE.MeshStandardMaterial({
            color: accentHex,
            wireframe: true,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending
        });
        const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
        ship.add(shieldMesh);

        ship.scale.set(0.68, 0.68, 0.68);
        
        ship.traverse(child => {
            if (child.isMesh && child !== shieldMesh && child.material.type !== 'MeshBasicMaterial') {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        
        return {
            group: ship,
            shieldMesh: shieldMesh,
            shieldIntensity: 0,
            thrusters: thrusterNozzlePositions
        };
    }

    function buildAlienEntity() {
        const alienGroup = new THREE.Group();

        const coreGeo = new THREE.IcosahedronGeometry(1.4, 1);
        const coreMat = new THREE.MeshPhongMaterial({
            color: 0xff0055,
            emissive: 0xbb0033,
            emissiveIntensity: 0.95,
            specular: 0xff88bb,
            shininess: 90,
            flatShading: true
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        alienGroup.add(core);

        const plateGeo = new THREE.DodecahedronGeometry(1.85, 0);
        const plateMat = new THREE.MeshStandardMaterial({
            color: 0x120d18,
            bumpMap: hullBumpTexture,
            bumpScale: 0.05,
            wireframe: true,
            metalness: 0.9,
            roughness: 0.2
        });
        const plates = new THREE.Mesh(plateGeo, plateMat);
        alienGroup.add(plates);

        const shardGeo = new THREE.TetrahedronGeometry(0.48);
        const shardMat = new THREE.MeshStandardMaterial({ color: 0x1a1224, metalness: 0.95, roughness: 0.1 });

        for (let i = 0; i < 6; i++) {
            const shard = new THREE.Mesh(shardGeo, shardMat);
            const angle = (i / 6) * Math.PI * 2;
            shard.position.set(Math.cos(angle) * 2.3, Math.sin(angle) * 2.3, (Math.random() - 0.5) * 1.5);
            shard.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
            alienGroup.add(shard);
        }

        alienGroup.scale.set(0.8, 0.8, 0.8);
        alienGroup.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        return alienGroup;
    }

    function initSpaceBattle() {
        ships.forEach(s => scene.remove(s.mesh));
        aliens.forEach(a => scene.remove(a.mesh));
        ships = [];
        aliens = [];

        const shipConfigs = [
            { color: 0xd2f872, speed: 0.0075, orbitR: 13.5, orbitY: 3.5, phase: 0 },
            { color: 0x56c6f3, speed: 0.006, orbitR: 16.0, orbitY: -4.5, phase: Math.PI * 0.66 },
            { color: 0xe4b5f0, speed: 0.007, orbitR: 14.5, orbitY: 1.0, phase: Math.PI * 1.33 }
        ];

        shipConfigs.forEach(cfg => {
            const shipObj = buildDetailedGunship(cfg.color);
            scene.add(shipObj.group);
            ships.push({
                mesh: shipObj.group,
                shieldMesh: shipObj.shieldMesh,
                shieldIntensity: 0,
                thrusters: shipObj.thrusters,
                color: cfg.color,
                orbitR: cfg.orbitR,
                orbitY: cfg.orbitY,
                speed: cfg.speed,
                phase: cfg.phase
            });
        });

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

    // ─── Cannon Muzzle Flashes & Lasers ───
    function fireLaser(fromPos, toPos, colorHex) {
        const dir = new THREE.Vector3().subVectors(toPos, fromPos).normalize();
        const distance = fromPos.distanceTo(toPos);

        // 1. Spawn Muzzle Flash Light Burst
        const mFlashLight = new THREE.PointLight(colorHex, 6.0, 10);
        mFlashLight.position.copy(fromPos);
        scene.add(mFlashLight);

        muzzleFlashes.push({ light: mFlashLight, life: 0, maxLife: 5 });

        // 2. Spawn Laser Bolt
        const laserGeo = new THREE.CylinderGeometry(0.065, 0.065, 1.8, 6);
        laserGeo.rotateX(Math.PI / 2);
        const laserMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.98 });
        const laserMesh = new THREE.Mesh(laserGeo, laserMat);

        laserMesh.position.copy(fromPos);
        laserMesh.lookAt(toPos);

        scene.add(laserMesh);

        lasers.push({
            mesh: laserMesh,
            dir: dir,
            speed: 0.95,
            targetPos: toPos.clone(),
            life: 0,
            maxLife: Math.min(distance / 0.95, 45)
        });
    }

    function spawnEngineTrails() {
        ships.forEach(ship => {
            ship.thrusters.forEach(tPos => {
                const worldPos = tPos.clone().applyMatrix4(ship.mesh.matrixWorld);
                const pGeo = new THREE.SphereGeometry(0.14, 6, 6);
                const pMat = new THREE.MeshBasicMaterial({
                    color: ship.color,
                    transparent: true,
                    opacity: 0.8,
                    blending: THREE.AdditiveBlending
                });
                const pMesh = new THREE.Mesh(pGeo, pMat);
                pMesh.position.copy(worldPos);
                scene.add(pMesh);

                engineTrails.push({ mesh: pMesh, life: 0, maxLife: 14, scale: 1 });
            });
        });
    }

    function createExplosion(position, colorHex) {
        const particleCount = 22;
        const group = new THREE.Group();
        group.position.copy(position);

        const pGeo = new THREE.SphereGeometry(0.1, 6, 6);
        const pMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 1 });

        const pData = [];
        for (let i = 0; i < particleCount; i++) {
            const p = new THREE.Mesh(pGeo, pMat.clone());
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 0.5,
                (Math.random() - 0.5) * 0.5,
                (Math.random() - 0.5) * 0.5
            );
            group.add(p);
            pData.push({ mesh: p, vel: vel });
        }

        scene.add(group);
        explosions.push({ group: group, particles: pData, life: 0, maxLife: 24 });
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

            const motionDir = new THREE.Vector3().subVectors(ship.mesh.position, prevPos);
            if (motionDir.lengthSq() > 0.0001) {
                const lookTarget = ship.mesh.position.clone().add(motionDir);
                ship.mesh.lookAt(lookTarget);
            }

            // Shield Pulse Decay
            if (ship.shieldIntensity > 0) {
                ship.shieldIntensity -= 0.05;
                ship.shieldMesh.material.opacity = Math.max(0, ship.shieldIntensity * 0.45);
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

        // 3. Engine Plasma Particles
        if (Math.random() > 0.3) {
            spawnEngineTrails();
        }

        for (let i = engineTrails.length - 1; i >= 0; i--) {
            const tr = engineTrails[i];
            tr.life++;
            const alpha = 1 - (tr.life / tr.maxLife);
            tr.mesh.material.opacity = alpha * 0.8;
            tr.mesh.scale.multiplyScalar(0.92);

            if (tr.life >= tr.maxLife) {
                scene.remove(tr.mesh);
                engineTrails.splice(i, 1);
            }
        }

        // 4. Muzzle Flashes
        for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
            const mf = muzzleFlashes[i];
            mf.life++;
            mf.light.intensity = (1 - (mf.life / mf.maxLife)) * 6.0;

            if (mf.life >= mf.maxLife) {
                scene.remove(mf.light);
                muzzleFlashes.splice(i, 1);
            }
        }

        // 5. Firing Lasers
        if (t - lastShotTime > 0.7 && ships.length > 0 && aliens.length > 0) {
            lastShotTime = t;
            const randomShip = ships[Math.floor(Math.random() * ships.length)];
            const randomAlien = aliens[Math.floor(Math.random() * aliens.length)];

            randomShip.shieldIntensity = 1.0; // Trigger ship shield glow on salvo

            const nosePos = randomShip.mesh.position.clone().add(new THREE.Vector3(0, 0, -1.8));
            fireLaser(nosePos, randomAlien.mesh.position, randomShip.color);
        }

        // 6. Advance Lasers
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

        // 7. Advance Explosions
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

        // Rotate Concentric Orbital Station & Cosmic Nebulae
        if (stationGroup) {
            stationGroup.rotation.z = t * 0.04;
            outerRing.rotation.z = -t * 0.02;
            innerRing.rotation.z = t * 0.03;

            if (centerCore) {
                const s = 1 + Math.sin(t * 2.5) * 0.06;
                centerCore.scale.set(s, s, s);
            }

            pointLight1.position.x = Math.sin(t * 0.7) * 17;
            pointLight1.position.z = Math.cos(t * 0.7) * 17;

            pointLight2.position.x = -Math.sin(t * 0.5) * 17;
            pointLight2.position.z = -Math.cos(t * 0.5) * 17;

            camera.position.x = mouseX * 3.0;
            camera.position.y = -mouseY * 3.0;
            camera.lookAt(scene.position);
        }

        if (nebulaGroup) {
            nebulaGroup.rotation.z = t * 0.01;
        }

        if (particles) {
            particles.rotation.y = t * 0.03;
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

                target.style.setProperty('--shine-x', `${(x / rect.width * 100).toFixed(1)}%`);
                target.style.setProperty('--shine-y', `${(y / rect.height * 100).toFixed(1)}%`);
            });

            target.addEventListener('mouseleave', function () {
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
    window.GM_LOGIN_3D = {
        init: init3D,
        start: startLoop,
        stop: stopLoop
    };
})();

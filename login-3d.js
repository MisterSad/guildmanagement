/**
 * login-3d.js — Interactive 3D WebGL Background & CSS 3D Card Tilt
 * Powered by Three.js for FGF Guild Management v3
 */

(function () {
    'use strict';

    let scene, camera, renderer;
    let coreGroup, innerCore, outerWireframe, ring1, ring2, particles;
    let pointLight1, pointLight2;
    let animationFrameId = null;
    let isRunning = false;

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
        camera.position.z = 18;

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
        const ambientLight = new THREE.AmbientLight(0x19202e, 1.2);
        scene.add(ambientLight);

        // Lime light (#d2f872 -> 0xd2f872)
        pointLight1 = new THREE.PointLight(0xd2f872, 2.5, 50);
        pointLight1.position.set(12, 10, 10);
        scene.add(pointLight1);

        // Cyan light (#56c6f3 -> 0x56c6f3)
        pointLight2 = new THREE.PointLight(0x56c6f3, 3.0, 50);
        pointLight2.position.set(-12, -10, 8);
        scene.add(pointLight2);

        // 5. Central 3D Core Group
        coreGroup = new THREE.Group();

        // A. Inner Energy Crystal/Sphere
        const innerGeo = new THREE.IcosahedronGeometry(2.8, 1);
        const innerMat = new THREE.MeshPhongMaterial({
            color: 0xd2f872,
            emissive: 0x2d4808,
            specular: 0xffffff,
            shininess: 90,
            transparent: true,
            opacity: 0.75,
            flatShading: true
        });
        innerCore = new THREE.Mesh(innerGeo, innerMat);
        coreGroup.add(innerCore);

        // B. Outer Wireframe Polyhedron
        const outerGeo = new THREE.IcosahedronGeometry(4.2, 2);
        const outerMat = new THREE.MeshStandardMaterial({
            color: 0x56c6f3,
            wireframe: true,
            transparent: true,
            opacity: 0.35,
            roughness: 0.3,
            metalness: 0.8
        });
        outerWireframe = new THREE.Mesh(outerGeo, outerMat);
        coreGroup.add(outerWireframe);

        // C. Orbiting Holographic Rings
        const ringGeo1 = new THREE.TorusGeometry(5.4, 0.06, 16, 100);
        const ringMat1 = new THREE.MeshBasicMaterial({
            color: 0x56c6f3,
            wireframe: true,
            transparent: true,
            opacity: 0.5
        });
        ring1 = new THREE.Mesh(ringGeo1, ringMat1);
        ring1.rotation.x = Math.PI / 3;
        ring1.rotation.y = Math.PI / 6;
        coreGroup.add(ring1);

        const ringGeo2 = new THREE.TorusGeometry(6.5, 0.04, 16, 100);
        const ringMat2 = new THREE.MeshBasicMaterial({
            color: 0xd2f872,
            wireframe: true,
            transparent: true,
            opacity: 0.4
        });
        ring2 = new THREE.Mesh(ringGeo2, ringMat2);
        ring2.rotation.x = -Math.PI / 4;
        ring2.rotation.z = Math.PI / 4;
        coreGroup.add(ring2);

        scene.add(coreGroup);

        // 6. Particle Field (Stars & Energy Dust)
        const particleCount = 1000;
        const particleGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        const colorLime = new THREE.Color(0xd2f872);
        const colorCyan = new THREE.Color(0x56c6f3);
        const colorWhite = new THREE.Color(0xffffff);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 60;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 60;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 50;

            let c = Math.random() > 0.5 ? colorLime : (Math.random() > 0.2 ? colorCyan : colorWhite);
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
            opacity: 0.7,
            blending: THREE.AdditiveBlending
        });

        particles = new THREE.Points(particleGeo, particleMat);
        scene.add(particles);

        // Position core group slightly offset for split aesthetic on wide screens
        updateCorePosition();

        // 7. Event listeners
        window.addEventListener('resize', onWindowResize, false);
        window.addEventListener('mousemove', onMouseMove, false);

        initCardTilt();
        startLoop();
    }

    function updateCorePosition() {
        if (!coreGroup) return;
        if (window.innerWidth > 960) {
            coreGroup.position.x = -6.5;
            coreGroup.position.y = 0;
        } else {
            coreGroup.position.x = 0;
            coreGroup.position.y = 4;
        }
    }

    function onWindowResize() {
        windowHalfX = window.innerWidth / 2;
        windowHalfY = window.innerHeight / 2;
        if (!camera || !renderer) return;

        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);

        updateCorePosition();
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

        // Rotate 3D Objects
        const t = time * 0.001;

        if (coreGroup) {
            innerCore.rotation.x = t * 0.4;
            innerCore.rotation.y = t * 0.6;

            outerWireframe.rotation.x = -t * 0.2;
            outerWireframe.rotation.y = -t * 0.35;

            ring1.rotation.z = t * 0.3;
            ring2.rotation.y = -t * 0.25;

            // Wobble energy core scale slightly
            const scale = 1 + Math.sin(t * 2) * 0.05;
            innerCore.scale.set(scale, scale, scale);

            // Orbit lights
            pointLight1.position.x = Math.sin(t * 0.8) * 15;
            pointLight1.position.z = Math.cos(t * 0.8) * 15;

            pointLight2.position.x = -Math.sin(t * 0.6) * 15;
            pointLight2.position.z = -Math.cos(t * 0.6) * 15;

            // Camera subtle parallax
            camera.position.x = mouseX * 2.5;
            camera.position.y = -mouseY * 2.5;
            camera.lookAt(scene.position);
        }

        if (particles) {
            particles.rotation.y = t * 0.05;
        }

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
        const cards = document.querySelectorAll('.gm-login-card');
        cards.forEach(card => {
            card.addEventListener('mousemove', function (e) {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;

                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                const rotateX = ((y - centerY) / centerY) * -10; // max 10 deg
                const rotateY = ((x - centerX) / centerX) * 10;  // max 10 deg

                card.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateZ(8px)`;
                
                // Update Specular Highlight position
                card.style.setProperty('--shine-x', `${(x / rect.width * 100).toFixed(1)}%`);
                card.style.setProperty('--shine-y', `${(y / rect.height * 100).toFixed(1)}%`);
            });

            card.addEventListener('mouseleave', function () {
                card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateZ(0px)';
                card.style.setProperty('--shine-x', '50%');
                card.style.setProperty('--shine-y', '50%');
            });
        });
    }

    // ─── Observe View Visiblity to pause GPU when logged in ───
    function setupVisibilityObserver() {
        const loginView = document.getElementById('login-view');
        const portalView = document.getElementById('player-portal-view');

        const observer = new MutationObserver(() => {
            const isLoginActive = loginView && !loginView.classList.contains('hidden');
            const isPortalActive = portalView && !portalView.classList.contains('hidden');

            if (isLoginActive || isPortalActive) {
                startLoop();
            } else {
                stopLoop();
            }
        });

        if (loginView) observer.observe(loginView, { attributes: true, attributeFilter: ['class'] });
        if (portalView) observer.observe(portalView, { attributes: true, attributeFilter: ['class'] });
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

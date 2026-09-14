import { useEffect } from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ES module, no .d.ts; imported for its side effect
// of defining the custom element.
import '../meta-service-menu.js';

/**
 * ServiceNav — the neighbouring meta-* services, as a burger menu.
 *
 * Since meta-discovery v1 this is a thin wrapper around <meta-service-menu>,
 * a framework-free custom element shared by every meta-* UI (see
 * scripts/check-mirrors.sh). The old implementation was ~165 lines of React
 * that existed in four near-identical copies and polled meta-core's
 * /api/services; the element polls this service's own /api/neighbors instead,
 * so the nav still renders when meta-core is down.
 *
 * The element lives in shadow DOM and cannot see this app's CSS variables, so
 * the four --mm-nav-* tokens below map our palette onto it.
 */

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace JSX {
        interface IntrinsicElements {
            'meta-service-menu': React.DetailedHTMLProps<
                React.HTMLAttributes<HTMLElement>,
                HTMLElement
            > & { current?: string; endpoint?: string; label?: string };
        }
    }
}

function ServiceNav() {
    useEffect(() => {
        // Import above is for the side effect of defining the element; this
        // keeps bundlers from tree-shaking it away in production builds.
    }, []);

    return (
        <>
            <meta-service-menu current="meta-dup" />
            <style>{`
                meta-service-menu {
                    --mm-nav-fg: var(--text-primary, #e0e0e0);
                    --mm-nav-bg: var(--bg-tertiary, var(--bg-secondary, #1a1a2e));
                    --mm-nav-border: var(--border-color, rgba(255,255,255,0.14));
                    --mm-nav-accent: var(--accent-primary, #4ecdc4);
                }
            `}</style>
        </>
    );
}

export default ServiceNav;

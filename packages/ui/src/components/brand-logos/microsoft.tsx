import type * as React from "react";

const MicrosoftLogo = (props: React.SVGProps<SVGSVGElement>) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 23 23"
		xmlns="http://www.w3.org/2000/svg"
		{...props}
	>
		<path d="M1 1h10v10H1z" fill="#f25022" />
		<path d="M12 1h10v10H12z" fill="#7fba00" />
		<path d="M1 12h10v10H1z" fill="#00a4ef" />
		<path d="M12 12h10v10H12z" fill="#ffb900" />
	</svg>
);

export default MicrosoftLogo;

export interface Picture {
  src: string;
  alt: string;
  width: number;
  height: number;
  srcset?: string;
  sizes?: string;
  sequence?: {
    desktop: string;
    phone: string;
    phoneWidth: number;
    phoneHeight: number;
    frames: number;
  };
}

const root = "/images/enterprise/government";
const editorialWidths = [480, 768, 1200, 1536];

function photo(name: string, alt: string, sizes: string, widths = editorialWidths): Picture {
  return {
    src: `${root}/${name}-${widths[1]}.webp`,
    srcset: widths.map((width) => `${root}/${name}-${width}.webp ${width}w`).join(", "),
    sizes: `auto, ${sizes}`,
    alt,
    width: widths[1],
    height: widths[1] * 2 / 3,
  };
}

function banner(name: string, frames: number, alt: string): Picture {
  const desktop = `/scroll/gov/${name}-d`;
  return {
    src: `${desktop}/0000.webp`,
    alt,
    width: 1600,
    height: 686,
    sequence: {
      desktop,
      phone: `/scroll/gov/${name}-p`,
      phoneWidth: 832,
      phoneHeight: 468,
      frames,
    },
  };
}

const timeline = "(max-width: 767px) calc(100vw - 40px), (max-width: 783px) calc((100vw - 64px) / 2 - 24px), (max-width: 1023px) calc((100vw - 64px) / 3 - 24px), 336px";
const policy = "(max-width: 767px) calc(100vw - 82px), (max-width: 1011px) calc((100vw - 88px) / 2 - 54px), 374px";

export const governmentPictures = {
  app: photo("extra-app-desk", "Half-closed laptop and a notebook under a desk lamp.", "(max-width: 767px) calc(100vw - 40px), (max-width: 899px) calc(100vw - 64px), 572px"),
  gates: banner("gates", 49, "Iron gates between lantern-lit stone pillars at dusk."),
  timeline: [
    photo("item1-device-locker", "Laptop and phone in an open steel device locker.", timeline),
    photo("item2-committee-room", "Empty committee room with microphones around a horseshoe table.", timeline),
    photo("item3-witness-table", "Microphone and water glass at an empty witness table facing the committee bench.", timeline),
    photo("item4-switches-off", "", timeline),
  ],
  library: banner("library", 37, "Closed book beneath a green reading lamp in a wood-paneled library."),
  policy: [
    photo("card1-art28-contract", "Fountain pen laid across a contract's signature lines.", policy),
    photo("card2-art25-32-lock", "Brass key in the lock of a wooden door.", policy),
    photo("card3-classifications-folders", "Ribbon-tied archival folders with colored tabs.", policy),
    photo("card4-cloud-act-envelope", "Sealed envelope beside a closed laptop.", policy),
  ],
  compliance: photo("extra-compliance-glassdoor", "An empty meeting room seen through timber-and-glass doors.", "(max-width: 561px) calc(100vw - 82px), (max-width: 1099px) 480px, 320px", [640, 960]),
  questions: photo("extra-questions-switchroom", "Steel switchroom door with a small access reader.", "(max-width: 767px) calc(100vw - 40px), (max-width: 1099px) calc((100vw - 112px) / 2.5), 536px"),
};

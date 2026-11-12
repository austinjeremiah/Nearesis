export default function Header() {
  return (
    <header data-wf--main-header-section--variant="base" className="main-header-section">
      <div className="section-wrap">
        <div className="main-header-flex">
          <a href="/" aria-current="page" className="main-header-logo-box w-inline-block w--current">
            <img loading="lazy" src="/assets/klero_logo.svg" alt="Klero logo" className="main-header-logo black" style={{ height: "40px", width: "auto" }} />
            <img loading="lazy" src="/assets/klero_logo_white.svg" alt="Klero logo" className="main-header-logo white" style={{ height: "40px", width: "auto" }} />
          </a>
          <div className="main-header-navbar">
            <div className="main-header-navigation">
              <a href="#about" className="main-header-navigation-link">
                ABOUT
              </a>
              <div className="main-header-navigation-dot" />
              <a href="#safeguards" className="main-header-navigation-link">
                SAFEGUARDS
              </a>
              <div className="main-header-navigation-dot" />
              <a href="#how-it-works" className="main-header-navigation-link">
                HOW IT WORKS
              </a>
              <div className="main-header-navigation-dot" />
              <a href="#faq" className="main-header-navigation-link last">
                FAQ
              </a>
            </div>
            <div className="header-button-box">
              <div className="header-button-line one" />
              <div className="header-button-line two" />
              <div className="header-button-line three" />
            </div>
          </div>
          <div className="main-header-btn-box">
            <a data-wf--primary-button--variant="main-button" href="/login" className="primary-button w-inline-block">
              <div className="primary-button-text-items">
                <div className="primary-button-text-wrap">
                  <div className="primary-button-text one">
                    TRY KLERO
                  </div>
                  <div className="primary-button-text two">
                    TRY KLERO
                  </div>
                </div>
              </div>
              <div className="primary-button-icon-wrap">
                <div className="primary-button-icon-box">
                  <img src="/assets/6a940bdd07117569c26e60b8_btn_icon.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                </div>
                <div className="primary-button-icon-box">
                  <img src="/assets/6a940df507117569c26eab94_btn_icon_2.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                </div>
                <div className="primary-button-icon-box two">
                  <img src="/assets/6a9d5d892f159f58a1b00821_btn_icon_3.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                </div>
                <div className="primary-button-icon-box two">
                  <img src="/assets/6a9d5d88f0c4f20f0444af57_btn_icon_4.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                </div>
              </div>
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}

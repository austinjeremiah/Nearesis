export default function About() {
  return (
    <section id="about" className="home-about-sectin">
      <div data-wf--section-wrap--variant="main-mood" className="section-wrap">
        <div className="container title-container top-border">
          <div className="section-title-flex">
            <h2 className="section-title">
              ABOUT KLERO
            </h2>
            <div className="section-title section-number">
              001
            </div>
          </div>
        </div>
        <div className="section-dot-flex">
          <div className="section-dot one" />
          <div className="section-dot-border" />
          <div className="section-dot two" />
        </div>
      </div>
      <div className="section-wrap">
        <div className="container top-border">
          <div className="home-about-flex">
            <div fade-anim="True" className="home-about-info-wrap">
              <div data-wf--section-info-card-wrap--variant="base" className="section-info-card-wrap">
                <div className="section-info-card-flex">
                  <div className="section-info-card-dot" />
                  <div className="utility-arrow-wrap another">
                    <div className="utility-arrow-box home">
                      <img loading="lazy" src="/assets/6a95383a400cc970a12e3d98_arrow_2.svg" alt="Arrow" className="utility-arrow" />
                    </div>
                    <div className="utility-arrow-box home">
                      <img loading="lazy" src="/assets/6a95383a400cc970a12e3d98_arrow_2.svg" alt="Arrow" className="utility-arrow" />
                    </div>
                    <div className="utility-arrow-box home">
                      <img loading="lazy" src="/assets/6a95383a400cc970a12e3d98_arrow_2.svg" alt="Arrow" className="utility-arrow" />
                    </div>
                  </div>
                </div>
                <div className="section-info-card-text">
                  PAY ONCE
                </div>
                <div className="section-info-card-shape" />
              </div>
            </div>
            <div className="home-about-content-flex">
              <div className="home-about-content-wrap">
                <div fade-anim="True" className="home-about-content-title-box">
                  <div className="home-about-content-title">
                    {"The exactly-once layer for AI agent payments\u2028built on Hedera and World ID\u2028"}
                    <br />
                    One job, one winner, one payment
                  </div>
                </div>
                <div fade-anim="True" className="home-about-author-wrap">
                  <div className="home-about-author-img-box">
                    <img src="/assets/klero-mark.svg" loading="lazy" alt="Klero" className="home-about-author-img" />
                  </div>
                  <div className="home-about-author-info-box">
                    <div className="home-about-author-name">
                      KLERO
                    </div>
                    <p className="home-about-author-designation">
                      ETHGLOBAL MUMBAI · 2026
                    </p>
                  </div>
                </div>
              </div>
              <div className="home-about-content-wrap">
                <div fade-anim="True" className="home-about-content-button-box">
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
                <div className="home-about-card-wrap">
                  <div scale-y-up="True" className="home-about-card-items">
                    <div className="home-about-card-border-wrap">
                      <div className="home-about-card-border-dot" />
                      <div className="home-about-card-border-line" />
                    </div>
                    <div className="home-about-card-box">
                      <div className="home-about-card-title">
                        One winner per job
                      </div>
                      <p className="home-about-card-text">
                        Every claim lands on a Hedera Consensus Service topic. The first valid claim wins, and anyone can recompute the winner from public data.
                      </p>
                    </div>
                  </div>
                  <div scale-y-up="True" className="home-about-card-items">
                    <div className="home-about-card-border-wrap">
                      <div className="home-about-card-border-dot" />
                      <div className="home-about-card-border-line" />
                    </div>
                    <div className="home-about-card-box">
                      <div className="home-about-card-title">
                        Payments that expire
                      </div>
                      <p className="home-about-card-text">
                        Each payment has a known transaction id and dies 120 seconds after its valid start. Retries resend the same bytes and never sign a new payment.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

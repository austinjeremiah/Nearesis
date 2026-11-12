import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Hero from '@/components/sections/Hero';
import BrandLogos from '@/components/sections/BrandLogos';
import About from '@/components/sections/About';
import Features from '@/components/sections/Features';
import Intelligent from '@/components/sections/Intelligent';
import Statistics from '@/components/sections/Statistics';
import Utility from '@/components/sections/Utility';
import Benefits from '@/components/sections/Benefits';
import Services from '@/components/sections/Services';
import Testimonials from '@/components/sections/Testimonials';
import Process from '@/components/sections/Process';
import Blogs from '@/components/sections/Blogs';
import Pricing from '@/components/sections/Pricing';
import Automation from '@/components/sections/Automation';
import Faq from '@/components/sections/Faq';
import Cta from '@/components/sections/Cta';

export default function Home() {
  return (
    <>
      <div id="Page-Wrapper" className="page-wrapper">
        <Header />
        <Hero />
        <BrandLogos />
        <About />
        <Features />
        <Intelligent />
        <Statistics />
        <Utility />
        <Benefits />
        <Services />
        <Testimonials />
        <Process />
        <Blogs />
        <Pricing />
        <Automation />
        <Faq />
        <Cta />
        <Footer />
      </div>
    </>
  );
}

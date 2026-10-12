-- Dummy shop data for 5 existing GCU navme_pois rows (Jai Foods, Stationary,
-- The Chill Spot, Cafe Levista, China Bites). Images are stable picsum.photos
-- placeholders (seeded, so the same URL always returns the same photo).

INSERT INTO public.navme_shop (
  poi_id, organization_id, poi_type, shop_name, shop_category, tagline, description,
  logo_url, cover_image_url, gallery_images, rating, rating_count, price_range,
  phone, website_url, tags, hours, menu
) VALUES
(
  '18034a88-bb0e-4176-b279-98636bf903a8', 'db204331-02bd-4fa4-9c5d-569ea1d9329f', 'GCU',
  'Jai Foods', 'Fast Food', 'Quick bites, home-style taste',
  'Jai Foods is the go-to tiffin counter on campus for fresh idli, dosa, vada and filter coffee between classes.',
  'https://picsum.photos/seed/gcu-jaifoods-logo/200/200',
  'https://picsum.photos/seed/gcu-jaifoods-cover/900/500',
  '["https://picsum.photos/seed/gcu-jaifoods-1/700/500","https://picsum.photos/seed/gcu-jaifoods-2/700/500","https://picsum.photos/seed/gcu-jaifoods-3/700/500","https://picsum.photos/seed/gcu-jaifoods-4/700/500"]'::jsonb,
  4.3, 128, '₹50 - ₹150', '+91 98450 11223', null,
  '["Vegetarian","Quick Bites","Cash & UPI"]'::jsonb,
  '[{"day":"Mon","open":"08:00","close":"21:00","closed":false},{"day":"Tue","open":"08:00","close":"21:00","closed":false},{"day":"Wed","open":"08:00","close":"21:00","closed":false},{"day":"Thu","open":"08:00","close":"21:00","closed":false},{"day":"Fri","open":"08:00","close":"21:00","closed":false},{"day":"Sat","open":"08:00","close":"21:00","closed":false},{"day":"Sun","open":"09:00","close":"18:00","closed":false}]'::jsonb,
  '[{"category":"Breakfast","name":"Idli (2 pcs)","price":40,"veg":true,"description":"Steamed rice cakes served with sambar and chutney","image_url":"https://picsum.photos/seed/gcu-jaifoods-m1/300/200"},{"category":"Breakfast","name":"Masala Dosa","price":60,"veg":true,"description":"Crisp dosa with spiced potato filling","image_url":"https://picsum.photos/seed/gcu-jaifoods-m2/300/200"},{"category":"Breakfast","name":"Medu Vada (2 pcs)","price":35,"veg":true,"description":"Crisp fried lentil doughnuts","image_url":"https://picsum.photos/seed/gcu-jaifoods-m3/300/200"},{"category":"Meals","name":"Veg Meals (Full)","price":90,"veg":true,"description":"Rice, sambar, rasam, curry and curd","image_url":"https://picsum.photos/seed/gcu-jaifoods-m4/300/200"},{"category":"Meals","name":"Veg Fried Rice","price":80,"veg":true,"description":"Wok-tossed rice with mixed vegetables","image_url":"https://picsum.photos/seed/gcu-jaifoods-m5/300/200"},{"category":"Beverages","name":"Filter Coffee","price":20,"veg":true,"description":"South Indian filter coffee","image_url":"https://picsum.photos/seed/gcu-jaifoods-m6/300/200"},{"category":"Beverages","name":"Masala Chai","price":15,"veg":true,"description":"Spiced milk tea","image_url":"https://picsum.photos/seed/gcu-jaifoods-m7/300/200"}]'::jsonb
),
(
  '6b50c933-daec-4d40-847f-a3dc656024e1', 'db204331-02bd-4fa4-9c5d-569ea1d9329f', 'GCU',
  'Stationary', 'Stationery & Supplies', 'Everything for class, right on campus',
  'Campus stationery counter for notebooks, pens, project printing and binding, open through the week.',
  'https://picsum.photos/seed/gcu-stationary-logo/200/200',
  'https://picsum.photos/seed/gcu-stationary-cover/900/500',
  '["https://picsum.photos/seed/gcu-stationary-1/700/500","https://picsum.photos/seed/gcu-stationary-2/700/500","https://picsum.photos/seed/gcu-stationary-3/700/500"]'::jsonb,
  4.1, 64, '₹10 - ₹500', '+91 98450 22334', null,
  '["Printing","Xerox","Project Binding"]'::jsonb,
  '[{"day":"Mon","open":"08:30","close":"18:30","closed":false},{"day":"Tue","open":"08:30","close":"18:30","closed":false},{"day":"Wed","open":"08:30","close":"18:30","closed":false},{"day":"Thu","open":"08:30","close":"18:30","closed":false},{"day":"Fri","open":"08:30","close":"18:30","closed":false},{"day":"Sat","open":"08:30","close":"18:30","closed":false},{"day":"Sun","open":null,"close":null,"closed":true}]'::jsonb,
  '[{"category":"Stationery","name":"Ruled Notebook (200pg)","price":45,"veg":null,"description":"200-page single-ruled notebook","image_url":"https://picsum.photos/seed/gcu-stationary-m1/300/200"},{"category":"Stationery","name":"Ball Pen (Pack of 5)","price":50,"veg":null,"description":"Smooth-write blue ball pens","image_url":"https://picsum.photos/seed/gcu-stationary-m2/300/200"},{"category":"Stationery","name":"Chart Paper","price":15,"veg":null,"description":"A2 chart sheet, assorted colors","image_url":"https://picsum.photos/seed/gcu-stationary-m3/300/200"},{"category":"Printing","name":"B/W Printout (per page)","price":2,"veg":null,"description":"Black and white laser printout","image_url":"https://picsum.photos/seed/gcu-stationary-m4/300/200"},{"category":"Printing","name":"Color Printout (per page)","price":10,"veg":null,"description":"Full-color laser printout","image_url":"https://picsum.photos/seed/gcu-stationary-m5/300/200"},{"category":"Services","name":"Project Spiral Binding","price":60,"veg":null,"description":"Spiral binding up to 200 pages","image_url":"https://picsum.photos/seed/gcu-stationary-m6/300/200"},{"category":"Services","name":"ID Card Lamination","price":20,"veg":null,"description":"Matte lamination, single card","image_url":"https://picsum.photos/seed/gcu-stationary-m7/300/200"}]'::jsonb
),
(
  'dba0c715-bd59-4abd-b09e-482e0c5f0ca9', 'db204331-02bd-4fa4-9c5d-569ea1d9329f', 'GCU',
  'The Chill Spot', 'Casual Dining', 'Chill between classes',
  'A relaxed hangout counter for shakes, maggi, sandwiches and fries, open every day of the week.',
  'https://picsum.photos/seed/gcu-chillspot-logo/200/200',
  'https://picsum.photos/seed/gcu-chillspot-cover/900/500',
  '["https://picsum.photos/seed/gcu-chillspot-1/700/500","https://picsum.photos/seed/gcu-chillspot-2/700/500","https://picsum.photos/seed/gcu-chillspot-3/700/500","https://picsum.photos/seed/gcu-chillspot-4/700/500"]'::jsonb,
  4.5, 212, '₹80 - ₹250', '+91 98450 33445', null,
  '["Milkshakes","Snacks","Outdoor Seating"]'::jsonb,
  '[{"day":"Mon","open":"10:00","close":"22:00","closed":false},{"day":"Tue","open":"10:00","close":"22:00","closed":false},{"day":"Wed","open":"10:00","close":"22:00","closed":false},{"day":"Thu","open":"10:00","close":"22:00","closed":false},{"day":"Fri","open":"10:00","close":"22:00","closed":false},{"day":"Sat","open":"10:00","close":"22:00","closed":false},{"day":"Sun","open":"10:00","close":"22:00","closed":false}]'::jsonb,
  '[{"category":"Snacks","name":"Masala Maggi","price":70,"veg":true,"description":"Classic masala noodles","image_url":"https://picsum.photos/seed/gcu-chillspot-m1/300/200"},{"category":"Snacks","name":"Loaded Nachos","price":120,"veg":true,"description":"Nachos with cheese, salsa and jalapenos","image_url":"https://picsum.photos/seed/gcu-chillspot-m2/300/200"},{"category":"Snacks","name":"Veg Club Sandwich","price":100,"veg":true,"description":"Triple-layer grilled sandwich","image_url":"https://picsum.photos/seed/gcu-chillspot-m3/300/200"},{"category":"Shakes","name":"Oreo Milkshake","price":130,"veg":true,"description":"Thick Oreo cookie shake","image_url":"https://picsum.photos/seed/gcu-chillspot-m4/300/200"},{"category":"Shakes","name":"Cold Coffee","price":90,"veg":true,"description":"Iced cold coffee with cream","image_url":"https://picsum.photos/seed/gcu-chillspot-m5/300/200"},{"category":"Sides","name":"French Fries","price":80,"veg":true,"description":"Crispy salted fries","image_url":"https://picsum.photos/seed/gcu-chillspot-m6/300/200"}]'::jsonb
),
(
  'c40c78db-5e50-4c46-b5e2-f3bb221e7549', 'db204331-02bd-4fa4-9c5d-569ea1d9329f', 'GCU',
  'Cafe Levista', 'Café', 'Great coffee, great company',
  'Cafe Levista brings specialty coffee and all-day snacks to campus: espresso, cold brew and fresh bakes.',
  'https://picsum.photos/seed/gcu-levista-logo/200/200',
  'https://picsum.photos/seed/gcu-levista-cover/900/500',
  '["https://picsum.photos/seed/gcu-levista-1/700/500","https://picsum.photos/seed/gcu-levista-2/700/500","https://picsum.photos/seed/gcu-levista-3/700/500","https://picsum.photos/seed/gcu-levista-4/700/500"]'::jsonb,
  4.6, 340, '₹120 - ₹350', '+91 98450 44556', null,
  '["Specialty Coffee","WiFi","Study Friendly"]'::jsonb,
  '[{"day":"Mon","open":"08:00","close":"23:00","closed":false},{"day":"Tue","open":"08:00","close":"23:00","closed":false},{"day":"Wed","open":"08:00","close":"23:00","closed":false},{"day":"Thu","open":"08:00","close":"23:00","closed":false},{"day":"Fri","open":"08:00","close":"23:00","closed":false},{"day":"Sat","open":"08:00","close":"23:00","closed":false},{"day":"Sun","open":"08:00","close":"23:00","closed":false}]'::jsonb,
  '[{"category":"Coffee","name":"Cappuccino","price":140,"veg":true,"description":"Espresso with steamed milk foam","image_url":"https://picsum.photos/seed/gcu-levista-m1/300/200"},{"category":"Coffee","name":"Cafe Latte","price":150,"veg":true,"description":"Espresso with steamed milk","image_url":"https://picsum.photos/seed/gcu-levista-m2/300/200"},{"category":"Coffee","name":"Cold Brew","price":160,"veg":true,"description":"Slow-steeped cold coffee","image_url":"https://picsum.photos/seed/gcu-levista-m3/300/200"},{"category":"Coffee","name":"Americano","price":120,"veg":true,"description":"Espresso with hot water","image_url":"https://picsum.photos/seed/gcu-levista-m4/300/200"},{"category":"Bakery","name":"Butter Croissant","price":130,"veg":true,"description":"Flaky all-butter croissant","image_url":"https://picsum.photos/seed/gcu-levista-m5/300/200"},{"category":"Bakery","name":"Chocolate Brownie","price":110,"veg":true,"description":"Fudgy dark chocolate brownie","image_url":"https://picsum.photos/seed/gcu-levista-m6/300/200"},{"category":"Snacks","name":"Grilled Sandwich","price":170,"veg":true,"description":"Grilled veg and cheese sandwich","image_url":"https://picsum.photos/seed/gcu-levista-m7/300/200"}]'::jsonb
),
(
  '25a7213a-4c43-4a25-b7ae-2977584ead8b', 'db204331-02bd-4fa4-9c5d-569ea1d9329f', 'GCU',
  'China Bites', 'Chinese Fast Food', 'Wok-tossed favorites',
  'China Bites serves quick Indo-Chinese favorites: noodles, fried rice, manchurian and momos.',
  'https://picsum.photos/seed/gcu-chinabites-logo/200/200',
  'https://picsum.photos/seed/gcu-chinabites-cover/900/500',
  '["https://picsum.photos/seed/gcu-chinabites-1/700/500","https://picsum.photos/seed/gcu-chinabites-2/700/500","https://picsum.photos/seed/gcu-chinabites-3/700/500","https://picsum.photos/seed/gcu-chinabites-4/700/500"]'::jsonb,
  4.2, 97, '₹100 - ₹300', '+91 98450 55667', null,
  '["Indo-Chinese","Spicy","Takeaway"]'::jsonb,
  '[{"day":"Mon","open":"11:00","close":"21:30","closed":false},{"day":"Tue","open":"11:00","close":"21:30","closed":false},{"day":"Wed","open":"11:00","close":"21:30","closed":false},{"day":"Thu","open":"11:00","close":"21:30","closed":false},{"day":"Fri","open":"11:00","close":"21:30","closed":false},{"day":"Sat","open":"11:00","close":"21:30","closed":false},{"day":"Sun","open":"12:00","close":"21:00","closed":false}]'::jsonb,
  '[{"category":"Noodles","name":"Veg Hakka Noodles","price":110,"veg":true,"description":"Wok-tossed noodles with vegetables","image_url":"https://picsum.photos/seed/gcu-chinabites-m1/300/200"},{"category":"Rice","name":"Veg Fried Rice","price":100,"veg":true,"description":"Wok-tossed rice with vegetables","image_url":"https://picsum.photos/seed/gcu-chinabites-m2/300/200"},{"category":"Starters","name":"Veg Manchurian","price":120,"veg":true,"description":"Fried veg balls in tangy sauce","image_url":"https://picsum.photos/seed/gcu-chinabites-m3/300/200"},{"category":"Starters","name":"Spring Rolls (4pcs)","price":90,"veg":true,"description":"Crispy vegetable spring rolls","image_url":"https://picsum.photos/seed/gcu-chinabites-m4/300/200"},{"category":"Starters","name":"Veg Momos (6pcs)","price":100,"veg":true,"description":"Steamed vegetable dumplings","image_url":"https://picsum.photos/seed/gcu-chinabites-m5/300/200"},{"category":"Starters","name":"Chilli Paneer","price":150,"veg":true,"description":"Pan-fried paneer in spicy sauce","image_url":"https://picsum.photos/seed/gcu-chinabites-m6/300/200"}]'::jsonb
)
ON CONFLICT (poi_id) DO NOTHING;
